using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Libretro;
using games_vault.Libretro.Import;
using games_vault.Libretro.Dat;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Web;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using System.Globalization;

namespace games_vault.Controllers;

public class GamesController(
    AppDbContext db,
    UploadStagingStore stagingStore,
    LibretroDatabaseStore libretroStore,
    SystemDatIndexProvider systemDat,
    SystemFileStorage systemFileStorage,
    IInternalJobsClient internalJobs,
    games_vault.EverDrive.EverDriveGbFirmwareService everDriveFw,
    GameFileStorage fileStorage,
    IWebHostEnvironment env,
    IOptions<WebPlayerOptions> webPlayerOptions,
    IOptions<NosebleedOptions> nosebleedOptions,
    NosebleedSessionManager nosebleedSessions,
    NosebleedSeatManager nosebleedSeats,
    NosebleedTicketSigner nosebleedTickets) : Controller
{
    public async Task<IActionResult> Index(
        string? q,
        int page = 1,
        int pageSize = 25,
        int? batchId = null,
        int batchPage = 1,
        int batchPageSize = 50,
        bool openAdd = false,
        Guid? sessionId = null,
        int? networkShareId = null,
        string? networkQuery = null,
        Guid? webSessionId = null,
        int? webSourceId = null,
        string? webQuery = null,
        Guid? localSessionId = null,
        int? localFolderId = null,
        string? localQuery = null,
        CancellationToken cancellationToken = default)
    {
        var bank = await BuildGamesBankAsync(q, page, pageSize, batchId, cancellationToken);

        var savedBatches = await db.GameBatches
            .AsNoTracking()
            .OrderBy(x => x.Name)
            .Select(x => new GameBatch { Id = x.Id, Name = x.Name, CreatedUtc = x.CreatedUtc, UpdatedUtc = x.UpdatedUtc })
            .ToListAsync(cancellationToken);

        string? activeBatchName = null;
        IReadOnlyList<Game> batchGames = Array.Empty<Game>();
        var batchTotalCount = 0;
        batchPage = Math.Max(1, batchPage);
        batchPageSize = Math.Clamp(batchPageSize, 10, 100);
        var everDriveEligible = false;
        string? everDriveIneligible = null;
        if (bank.BatchId is not null && bank.BatchId > 0)
        {
            var batch = await db.GameBatches
                .AsNoTracking()
                .Where(x => x.Id == bank.BatchId.Value)
                .Select(x => new { x.Id, x.Name })
                .FirstOrDefaultAsync(cancellationToken);

            if (batch is not null)
            {
                activeBatchName = batch.Name;
                var batchItems = db.GameBatchItems
                    .AsNoTracking()
                    .Where(x => x.GameBatchId == batch.Id);

                batchTotalCount = await batchItems.CountAsync(cancellationToken);
                batchPage = batchTotalCount == 0 ? 1 : Math.Min(batchPage, (int)Math.Ceiling(batchTotalCount / (double)batchPageSize));

                batchGames = await batchItems
                    .OrderByDescending(x => x.AddedUtc)
                    .Skip((batchPage - 1) * batchPageSize)
                    .Take(batchPageSize)
                    .Select(x => x.Game)
                    .ToListAsync(cancellationToken);

                // EverDrive GB export eligibility: every game in the batch must be GB/GBC and must have at least one stored file.
                var gbSystem = "Nintendo - Game Boy";
                var gbcSystem = "Nintendo - Game Boy Color";

                var total = batchTotalCount;
                if (total == 0)
                {
                    everDriveEligible = false;
                    everDriveIneligible = "Batch is empty.";
                }
                else
                {
                    var invalidSystemCount = await db.GameBatchItems
                        .AsNoTracking()
                        .Where(x => x.GameBatchId == batch.Id)
                        .Where(x =>
                            !string.Equals(x.Game.SystemName, gbSystem, StringComparison.OrdinalIgnoreCase) &&
                            !string.Equals(x.Game.SystemName, gbcSystem, StringComparison.OrdinalIgnoreCase))
                        .CountAsync(cancellationToken);

                    if (invalidSystemCount > 0)
                    {
                        everDriveEligible = false;
                        everDriveIneligible = "EverDrive GB export supports only Game Boy and Game Boy Color batches.";
                    }
                    else
                    {
                        var storedGameCount = await db.GameFiles
                            .AsNoTracking()
                            .Where(f => (f.StoragePath != null || f.ExternalPath != null))
                            .Where(f => db.GameBatchItems.Any(i => i.GameBatchId == batch.Id && i.GameId == f.GameId))
                            .Select(f => f.GameId)
                            .Distinct()
                            .CountAsync(cancellationToken);

                        if (storedGameCount != total)
                        {
                            everDriveEligible = false;
                            everDriveIneligible = "Some games in this batch are missing stored ROM bytes. Re-import them so files are stored.";
                        }
                        else
                        {
                            everDriveEligible = true;
                        }
                    }
                }
            }
            else
            {
                bank = new GamesBankViewModel
                {
                    Games = bank.Games,
                    Query = bank.Query,
                    Page = bank.Page,
                    PageSize = bank.PageSize,
                    TotalCount = bank.TotalCount,
                    BatchId = null,
                    BatchGameIds = Array.Empty<int>()
                };
            }
        }

        ViewData["ReturnUrl"] = Url.Action(nameof(Index), new
        {
            q = bank.Query,
            page = bank.Page,
            pageSize = bank.PageSize,
            batchId = bank.BatchId,
            batchPage,
            batchPageSize
        }) ?? "/Games";

        IReadOnlyList<games_vault.EverDrive.EverDriveGbFirmwareOption> fwOptions = Array.Empty<games_vault.EverDrive.EverDriveGbFirmwareOption>();
        games_vault.EverDrive.EverDriveGbFirmwareOption? fwLatest = null;
        try
        {
            fwOptions = await everDriveFw.GetOptionsAsync(cancellationToken);
            fwLatest = fwOptions.FirstOrDefault();
        }
        catch
        {
            // If firmware listing can't be fetched (offline), we show a manual URL option in the UI.
        }

        var addGame = await BuildGameUploadCreateViewModelAsync(
            sessionId,
            networkShareId,
            networkQuery,
            webSessionId,
            webSourceId,
            webQuery,
            localSessionId,
            localFolderId,
            localQuery,
            cancellationToken);

        return View(new GamesIndexViewModel
        {
            Games = bank.Games,
            Query = bank.Query,
            Page = bank.Page,
            PageSize = bank.PageSize,
            TotalCount = bank.TotalCount,
            BatchId = bank.BatchId,
            BatchName = activeBatchName,
            SavedBatches = savedBatches,
            BatchGames = batchGames,
            BatchGameIds = bank.BatchGameIds,
            BatchPage = batchPage,
            BatchPageSize = batchPageSize,
            BatchTotalCount = batchTotalCount,
            EverDriveGbFirmwares = fwOptions,
            EverDriveGbLatest = fwLatest,
            EverDriveGbEligible = everDriveEligible,
            EverDriveGbIneligibleReason = everDriveIneligible,
            AddGame = addGame,
            OpenAddGameModal = openAdd || sessionId is not null || webSessionId is not null || localSessionId is not null,
            MissingSystemFilesBySystem = bank.MissingSystemFilesBySystem
        });
    }

    [HttpGet]
    public async Task<IActionResult> Bank(string? q, int page = 1, int pageSize = 25, int? batchId = null, CancellationToken cancellationToken = default)
    {
        Response.Headers.CacheControl = "no-store";

        var bank = await BuildGamesBankAsync(q, page, pageSize, batchId, cancellationToken);
        Response.Headers["X-Games-TotalCount"] = bank.TotalCount.ToString(CultureInfo.InvariantCulture);

        ViewData["ReturnUrl"] = Url.Action(nameof(Index), new { q = bank.Query, page = bank.Page, pageSize = bank.PageSize, batchId = bank.BatchId }) ?? "/Games";
        return PartialView("_GamesBank", bank);
    }

    private async Task<GamesBankViewModel> BuildGamesBankAsync(string? q, int page, int pageSize, int? batchId, CancellationToken cancellationToken)
    {
        q = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 5, 100);
        batchId = batchId is > 0 ? batchId : null;

        var query = db.Games.AsQueryable();

        if (q is not null)
        {
            var qLower = q.ToLower();
            query = query.Where(g =>
                g.Name.ToLower().Contains(qLower) ||
                g.SystemName.ToLower().Contains(qLower) ||
                g.Files.Any(f =>
                    f.Name.ToLower().Contains(qLower) ||
                    (f.Crc32 != null && f.Crc32.ToLower().Contains(qLower))));
        }

        var totalCount = await query.CountAsync(cancellationToken);

        var games = await query
            .Include(x => x.Files)
            .OrderByDescending(x => x.CreatedUtc)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        // System BIOS missing check (based on libretro System.dat expected paths).
        var missingBySystem = new Dictionary<string, SystemMissingInfo>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var idx = systemDat.Get();
            var systemsOnPage = games
                .Select(g => g.SystemName)
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var systemName in systemsOnPage)
            {
                if (!idx.BySystemGroup.TryGetValue(systemName, out var required))
                {
                    continue;
                }

                var missingCount = 0;
                var sample = new List<string>(capacity: 4);

                foreach (var r in required)
                {
                    try
                    {
                        var abs = systemFileStorage.GetAbsoluteSystemPath(r.RelativePath);
                        if (!System.IO.File.Exists(abs))
                        {
                            missingCount++;
                            if (sample.Count < 3)
                            {
                                sample.Add(Path.GetFileName(r.RelativePath));
                            }
                        }
                    }
                    catch
                    {
                        // Ignore invalid path errors; treat as unknown.
                    }
                }

                if (missingCount > 0)
                {
                    missingBySystem[systemName] = new SystemMissingInfo(missingCount, sample);
                }
            }
        }
        catch
        {
            // Best-effort: don't block games list rendering if System.dat isn't available.
        }

        IReadOnlyList<int> batchGameIds = Array.Empty<int>();
        if (batchId is not null)
        {
            var pageIds = games.Select(g => g.Id).ToArray();
            if (pageIds.Length > 0)
            {
                batchGameIds = await db.GameBatchItems
                    .AsNoTracking()
                    .Where(x => x.GameBatchId == batchId.Value && pageIds.Contains(x.GameId))
                    .Select(x => x.GameId)
                    .ToListAsync(cancellationToken);
            }
        }

        return new GamesBankViewModel
        {
            Games = games,
            Query = q,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount,
            BatchId = batchId,
            BatchGameIds = batchGameIds,
            MissingSystemFilesBySystem = missingBySystem
        };
    }

    private async Task<GameUploadCreateViewModel> BuildGameUploadCreateViewModelAsync(
        Guid? networkSessionId,
        int? networkShareId,
        string? networkQuery,
        Guid? webSessionId,
        int? webSourceId,
        string? webQuery,
        Guid? localSessionId,
        int? localFolderId,
        string? localQuery,
        CancellationToken cancellationToken)
    {
        var model = new GameUploadCreateViewModel { LibretroAvailable = libretroStore.HasDatFiles() };

        if (networkSessionId is not null && networkSessionId != Guid.Empty)
        {
            model.NetworkScanSessionId = networkSessionId.Value;
        }

        model.SelectedNetworkShareId = networkShareId;
        model.NetworkQuery = networkQuery;

        if (webSessionId is not null && webSessionId != Guid.Empty)
        {
            model.WebScanSessionId = webSessionId.Value;
        }

        model.SelectedWebSourceId = webSourceId;
        model.WebQuery = webQuery;

        if (localSessionId is not null && localSessionId != Guid.Empty)
        {
            model.LocalScanSessionId = localSessionId.Value;
        }

        model.SelectedLocalFolderId = localFolderId;
        model.LocalQuery = localQuery;

        if (!model.LibretroAvailable)
        {
            var latestSync = await db.BackgroundJobs
                .Where(x => x.Command == "libretro.sync")
                .OrderByDescending(x => x.CreatedUtc)
                .FirstOrDefaultAsync(cancellationToken);

            model.LibretroSyncJobId = latestSync?.Id;
            model.LibretroSyncStatus = latestSync?.Status.ToString();
        }

        model.NetworkShares = await db.NetworkShares
            .Where(s => s.Enabled)
            .OrderBy(s => s.Name)
            .ToListAsync(cancellationToken);

        model.WebSources = await db.WebSources
            .Where(s => s.Enabled)
            .OrderBy(s => s.Name)
            .ToListAsync(cancellationToken);

        model.LocalFolders = await db.LocalFolders
            .Where(f => f.Enabled)
            .OrderBy(f => f.Name)
            .ToListAsync(cancellationToken);

        return model;
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateBatch(string name, string? returnUrl, CancellationToken cancellationToken)
    {
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            TempData["Message"] = "Batch name is required.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        if (name.Length > 100)
        {
            name = name[..100];
        }

        var batch = new GameBatch { Name = name, CreatedUtc = DateTime.UtcNow };
        db.GameBatches.Add(batch);
        await db.SaveChangesAsync(cancellationToken);

        TempData["Message"] = $"Created batch '{batch.Name}'.";
        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            // Preserve current list filters while selecting the newly-created batch.
            var url = SetQueryParam(returnUrl, "batchId", batch.Id.ToString());
            url = SetQueryParam(url, "page", "1");
            return Redirect(url);
        }

        return RedirectToAction(nameof(Index), new { batchId = batch.Id });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RenameBatch(int batchId, string? name, string? returnUrl, CancellationToken cancellationToken)
    {
        if (batchId <= 0)
        {
            TempData["Message"] = "Batch not found.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        name = (name ?? "").Trim();
        if (name.Length > 100)
        {
            name = name[..100];
        }

        var batch = await db.GameBatches.FirstOrDefaultAsync(x => x.Id == batchId, cancellationToken);
        if (batch is null)
        {
            TempData["Message"] = "Batch not found.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        batch.Name = name;
        batch.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        TempData["Message"] = string.IsNullOrWhiteSpace(name) ? "Renamed batch to (unnamed batch)." : $"Renamed batch to '{name}'.";

        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            var url = SetQueryParam(returnUrl, "batchId", batchId.ToString(CultureInfo.InvariantCulture));
            return Redirect(url);
        }

        return RedirectToAction(nameof(Index), new { batchId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddToBatch(int id, int? batchId, string? returnUrl, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        GameBatch? batch = null;
        var effectiveBatchId = batchId.GetValueOrDefault();

        if (effectiveBatchId <= 0)
        {
            batch = new GameBatch { Name = "", CreatedUtc = now, UpdatedUtc = now };
            db.GameBatches.Add(batch);
            await db.SaveChangesAsync(cancellationToken);
            effectiveBatchId = batch.Id;
        }
        else
        {
            batch = await db.GameBatches.FirstOrDefaultAsync(x => x.Id == effectiveBatchId, cancellationToken);
            if (batch is null)
            {
                TempData["Message"] = "Batch not found.";
                return RedirectToLocalOrIndex(returnUrl);
            }
        }

        var gameExists = await db.Games.AnyAsync(x => x.Id == id, cancellationToken);
        if (!gameExists)
        {
            return NotFound();
        }

        var already = await db.GameBatchItems.AnyAsync(x => x.GameBatchId == effectiveBatchId && x.GameId == id, cancellationToken);
        if (!already)
        {
            if (batch is not null)
            {
                batch.UpdatedUtc = now;
            }
            db.GameBatchItems.Add(new GameBatchItem { GameBatchId = effectiveBatchId, GameId = id, AddedUtc = now });
            await db.SaveChangesAsync(cancellationToken);
        }

        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            var url = SetQueryParam(returnUrl, "batchId", effectiveBatchId.ToString(CultureInfo.InvariantCulture));
            url = SetQueryParam(url, "page", "1");
            return Redirect(url);
        }

        return RedirectToAction(nameof(Index), new { batchId = effectiveBatchId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteBatch(int batchId, string? returnUrl, CancellationToken cancellationToken)
    {
        if (batchId <= 0)
        {
            TempData["Message"] = "Batch not found.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        var batch = await db.GameBatches.AsNoTracking().FirstOrDefaultAsync(x => x.Id == batchId, cancellationToken);
        if (batch is null)
        {
            TempData["Message"] = "Batch not found.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        // Delete items first to be robust even if FK cascade is disabled.
        await db.GameBatchItems.Where(x => x.GameBatchId == batchId).ExecuteDeleteAsync(cancellationToken);
        await db.GameBatches.Where(x => x.Id == batchId).ExecuteDeleteAsync(cancellationToken);

        var batchLabel = string.IsNullOrWhiteSpace(batch.Name) ? "(unnamed batch)" : batch.Name;
        TempData["Message"] = $"Deleted batch {batchLabel}.";

        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            var url = SetQueryParam(returnUrl, "batchId", null);
            url = SetQueryParam(url, "batchPage", null);
            url = SetQueryParam(url, "batchPageSize", null);
            return Redirect(url);
        }

        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddSelectedToBatch(int[] ids, int? batchId, string? returnUrl, CancellationToken cancellationToken)
    {
        ids = (ids ?? Array.Empty<int>()).Where(x => x > 0).Distinct().ToArray();
        if (ids.Length == 0)
        {
            TempData["Message"] = "No games selected.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        var now = DateTime.UtcNow;
        var effectiveBatchId = batchId.GetValueOrDefault();
        GameBatch? batch = null;
        var createdBatch = false;

        if (effectiveBatchId <= 0)
        {
            createdBatch = true;
            batch = new GameBatch { Name = "", CreatedUtc = now, UpdatedUtc = now };
            db.GameBatches.Add(batch);
            await db.SaveChangesAsync(cancellationToken);
            effectiveBatchId = batch.Id;
        }
        else
        {
            batch = await db.GameBatches.FirstOrDefaultAsync(x => x.Id == effectiveBatchId, cancellationToken);
            if (batch is null)
            {
                TempData["Message"] = "Batch not found.";
                return RedirectToLocalOrIndex(returnUrl);
            }
        }

        // Filter out any ids that don't exist to avoid FK failures.
        var existingGames = await db.Games
            .AsNoTracking()
            .Where(x => ids.Contains(x.Id))
            .Select(x => x.Id)
            .ToListAsync(cancellationToken);

        var existingInBatch = await db.GameBatchItems
            .AsNoTracking()
            .Where(x => x.GameBatchId == effectiveBatchId && existingGames.Contains(x.GameId))
            .Select(x => x.GameId)
            .ToListAsync(cancellationToken);

        var existingSet = existingInBatch.ToHashSet();
        var toAdd = existingGames.Where(id => !existingSet.Contains(id)).ToList();

        if (toAdd.Count == 0)
        {
            TempData["Message"] = "Selected games are already in this batch.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        foreach (var id in toAdd)
        {
            db.GameBatchItems.Add(new GameBatchItem { GameBatchId = effectiveBatchId, GameId = id, AddedUtc = now });
        }

        if (batch is not null) batch.UpdatedUtc = now;
        await db.SaveChangesAsync(cancellationToken);

        var batchLabel = batch is null || string.IsNullOrWhiteSpace(batch.Name) ? "(unnamed batch)" : batch.Name;
        TempData["Message"] = createdBatch
            ? $"Created {batchLabel} and added {toAdd.Count} game(s)."
            : $"Added {toAdd.Count} game(s) to batch '{batchLabel}'.";

        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            var url = SetQueryParam(returnUrl, "batchId", effectiveBatchId.ToString(CultureInfo.InvariantCulture));
            url = SetQueryParam(url, "page", "1");
            return Redirect(url);
        }

        return RedirectToAction(nameof(Index), new { batchId = effectiveBatchId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartEverDriveGbImage(int batchId, string firmwareUrl, string firmwareLabel, string? returnUrl, CancellationToken cancellationToken)
    {
        if (batchId <= 0)
        {
            TempData["Message"] = "Select a batch first.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        if (string.IsNullOrWhiteSpace(firmwareUrl))
        {
            TempData["Message"] = "Firmware URL is required.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        firmwareUrl = firmwareUrl.Trim();
        firmwareLabel = string.IsNullOrWhiteSpace(firmwareLabel) ? firmwareUrl : firmwareLabel.Trim();

        var jobId = await internalJobs.EnqueueEverDriveGbImageAsync(batchId, firmwareUrl, firmwareLabel, cancellationToken);
        TempData["Message"] = $"Queued EverDrive GB image build job #{jobId}.";
        return RedirectToAction(nameof(JobsController.Details), "Jobs", new { id = jobId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartEverDriveGbZip(int batchId, string firmwareUrl, string firmwareLabel, string? returnUrl, CancellationToken cancellationToken)
    {
        if (batchId <= 0)
        {
            TempData["Message"] = "Select a batch first.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        if (string.IsNullOrWhiteSpace(firmwareUrl))
        {
            TempData["Message"] = "Firmware URL is required.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        firmwareUrl = firmwareUrl.Trim();
        firmwareLabel = string.IsNullOrWhiteSpace(firmwareLabel) ? firmwareUrl : firmwareLabel.Trim();

        var jobId = await internalJobs.EnqueueEverDriveGbZipAsync(batchId, firmwareUrl, firmwareLabel, cancellationToken);
        TempData["Message"] = $"Queued EverDrive GB zip build job #{jobId}.";
        return RedirectToAction(nameof(JobsController.Details), "Jobs", new { id = jobId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RemoveFromBatch(int id, int batchId, string? returnUrl, CancellationToken cancellationToken)
    {
        if (batchId <= 0)
        {
            return RedirectToLocalOrIndex(returnUrl);
        }

        var deleted = await db.GameBatchItems
            .Where(x => x.GameBatchId == batchId && x.GameId == id)
            .ExecuteDeleteAsync(cancellationToken);

        if (deleted > 0)
        {
            var batch = await db.GameBatches.FindAsync([batchId], cancellationToken);
            if (batch is not null)
            {
                batch.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(cancellationToken);
            }
        }

        return RedirectToLocalOrIndex(returnUrl);
    }

    private IActionResult RedirectToLocalOrIndex(string? returnUrl)
    {
        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            return Redirect(returnUrl);
        }

        return RedirectToAction(nameof(Index));
    }

    private static string SetQueryParam(string relativeUrl, string key, string? value)
    {
        // ParseQuery requires a URI, so use a dummy absolute base and return a relative path+query.
        var uri = new Uri(new Uri("http://localhost"), relativeUrl);

        var parsed = QueryHelpers.ParseQuery(uri.Query);
        var qb = new QueryBuilder();

        foreach (var kv in parsed)
        {
            if (string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var v in kv.Value)
            {
                if (v is not null)
                {
                    qb.Add(kv.Key, v);
                }
            }
        }

        if (!string.IsNullOrWhiteSpace(value))
        {
            qb.Add(key, value);
        }

        return uri.AbsolutePath + qb.ToQueryString();
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> BulkDelete(int[] ids, string? q, int page = 1, int pageSize = 25, int? batchId = null, CancellationToken cancellationToken = default)
    {
        if (ids.Length == 0)
        {
            TempData["Message"] = "No games selected.";
            return RedirectToAction(nameof(Index), new { q, page, pageSize, batchId });
        }

        var games = await db.Games
            .Where(g => ids.Contains(g.Id))
            .ToListAsync(cancellationToken);

        db.Games.RemoveRange(games);
        await db.SaveChangesAsync(cancellationToken);

        TempData["Message"] = $"Deleted {games.Count} game(s).";
        return RedirectToAction(nameof(Index), new { q, page, pageSize, batchId });
    }

    public async Task<IActionResult> Details(
        int id,
        int filePage = 1,
        int filePageSize = 50,
        int playerPage = 1,
        int playerPageSize = 50,
        CancellationToken cancellationToken = default)
    {
        filePage = Math.Max(1, filePage);
        filePageSize = Math.Clamp(filePageSize, 10, 100);
        playerPage = Math.Max(1, playerPage);
        playerPageSize = Math.Clamp(playerPageSize, 10, 100);

        var game = await db.Games
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (game is null)
        {
            return NotFound();
        }

        var filesQuery = db.GameFiles
            .AsNoTracking()
            .Where(f => f.GameId == game.Id);

        var totalCount = await filesQuery.CountAsync(cancellationToken);

        var files = await filesQuery
            .OrderBy(f => f.Name)
            .Skip((filePage - 1) * filePageSize)
            .Take(filePageSize)
            .ToListAsync(cancellationToken);

        var playerQuery = db.GamePlayerFiles
            .AsNoTracking()
            .Where(f => f.GameId == game.Id);

        var playerTotal = await playerQuery.CountAsync(cancellationToken);
        var playerPageCount = playerPageSize <= 0 ? 0 : (int)Math.Ceiling(playerTotal / (double)playerPageSize);
        playerPage = Math.Min(playerPage, Math.Max(1, playerPageCount));

        var playerFiles = await playerQuery
            .OrderByDescending(f => f.UpdatedUtc)
            .ThenBy(f => f.Kind)
            .ThenBy(f => f.Key)
            .ThenBy(f => f.FileName)
            .Skip((playerPage - 1) * playerPageSize)
            .Take(playerPageSize)
            .ToListAsync(cancellationToken);

        return View(new games_vault.Models.ViewModels.GameDetailsViewModel
        {
            Game = game,
            Files = files,
            FilePage = filePage,
            FilePageSize = filePageSize,
            FileTotalCount = totalCount,
            PlayerFiles = playerFiles,
            PlayerFilePage = playerPage,
            PlayerFilePageSize = playerPageSize,
            PlayerFileTotalCount = playerTotal
        });
    }

    public async Task<IActionResult> Play(int id, CancellationToken cancellationToken = default)
    {
        var game = await db.Games
            .AsNoTracking()
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.Id == id, cancellationToken);

        if (game is null)
        {
            return NotFound();
        }

        var opts = webPlayerOptions.Value ?? new WebPlayerOptions();
        var basePath = string.IsNullOrWhiteSpace(opts.BasePath) ? "/webplayer" : opts.BasePath.TrimEnd('/');
        if (!basePath.StartsWith("/", StringComparison.Ordinal))
        {
            basePath = "/" + basePath;
        }

        var file = game.Files.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f.StoragePath) || !string.IsNullOrWhiteSpace(f.ExternalPath));
        var romUrl = file is null ? null : (Url.Action(nameof(Rom), new { id = file.Id }) ?? $"/Games/Rom/{file.Id}");

        var coreKey = ResolveWebPlayerCoreKey(opts, game, file);

        var assetsPresent = IsWebPlayerAssetsPresent(opts, env);

        string? error = null;
        if (!opts.Enabled)
        {
            error = "Web player is disabled. Enable it in appsettings under 'WebPlayer:Enabled'.";
        }
        else if (file is null)
        {
            error = "No stored or linked ROM file found for this game.";
        }
        else if (string.IsNullOrWhiteSpace(coreKey))
        {
            error = $"No web-player core mapping found for '{game.SystemName}'. Configure 'WebPlayer:SystemCores' in appsettings.";
        }
        else if (!assetsPresent)
        {
            error = $"Web player assets not found under '{basePath}'.";
        }

        return View(new GamePlayViewModel
        {
            Game = game,
            File = file,
            PlayerEnabled = opts.Enabled,
            PlayerBasePath = basePath,
            PlayerAssetsPresent = assetsPresent,
            CoreKey = coreKey,
            RomUrl = romUrl,
            Error = error
        });
    }

    [HttpGet]
    public async Task<IActionResult> PlayServer(int id, CancellationToken cancellationToken = default)
    {
        var game = await db.Games
            .AsNoTracking()
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.Id == id, cancellationToken);

        if (game is null)
        {
            return NotFound();
        }

        var opts = nosebleedOptions.Value ?? new NosebleedOptions();
        var file = game.Files.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f.StoragePath) || !string.IsNullOrWhiteSpace(f.ExternalPath));
        string? error = null;
        NosebleedSession? session = null;
        NosebleedSeatAssignment? seat = null;
        string? token = null;
        string? contentPath = null;

        if (!opts.Enabled)
        {
            error = "Server-side playback is disabled. Enable it in appsettings under 'Nosebleed:Enabled'.";
        }
        else if (file is null)
        {
            error = "No stored or linked ROM file found for this game.";
        }
        else
        {
            contentPath = await ResolveGameFileAbsolutePathAsync(file, cancellationToken);
            if (string.IsNullOrWhiteSpace(contentPath))
            {
                error = "ROM file could not be resolved to an allowed local filesystem path.";
            }
            else
            {
                var result = await nosebleedSessions.StartOrReuseAsync(game.Id, file.Id, game.SystemName, contentPath, cancellationToken);
                if (result.Success && result.Session is not null)
                {
                    session = result.Session;
                    var viewerId = GetOrCreateNosebleedViewerId();
                    seat = nosebleedSeats.Assign(session.Id, viewerId, DateTimeOffset.UtcNow);
                    token = seat.Kind == NosebleedSeatKind.Player && seat.Port is not null
                        ? nosebleedTickets.CreatePlayerToken(session.Id, viewerId, seat.Port.Value)
                        : nosebleedTickets.CreateSpectatorToken(session.Id, viewerId);
                }
                else
                {
                    error = result.Error ?? "Failed to start server-side playback.";
                }
            }
        }

        return View(new ServerGamePlayViewModel
        {
            Game = game,
            File = file,
            PlayerEnabled = opts.Enabled,
            BaseUrl = session?.BaseUrl,
            Token = token,
            SessionId = session?.Id,
            AssignedPort = seat?.Port,
            PlayerNumber = seat?.PlayerNumber,
            IsSpectator = seat?.Kind == NosebleedSeatKind.Spectator,
            SeatExpiresUtc = seat?.ExpiresUtc,
            CorePath = session?.CorePath,
            ContentPath = session?.ContentPath ?? contentPath,
            Error = error
        });
    }

    [HttpPost]
    public IActionResult KeepAliveServerSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) ||
            !Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var viewerId) ||
            !Guid.TryParse(viewerId, out _))
        {
            return BadRequest();
        }

        var seat = nosebleedSeats.Assign(sessionId, viewerId, DateTimeOffset.UtcNow);
        return Json(new
        {
            kind = seat.Kind.ToString().ToLowerInvariant(),
            port = seat.Port,
            playerNumber = seat.PlayerNumber,
            expiresUtc = seat.ExpiresUtc
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult LeaveServerSession(string sessionId)
    {
        if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var viewerId))
        {
            nosebleedSeats.Release(sessionId, viewerId);
        }

        return RedirectToAction(nameof(Index));
    }

    [HttpGet]
    public async Task<IActionResult> Rom(int id, CancellationToken cancellationToken = default)
    {
        var file = await db.GameFiles
            .AsNoTracking()
            .FirstOrDefaultAsync(f => f.Id == id, cancellationToken);

        if (file is null)
        {
            return NotFound();
        }

        string? abs = null;
        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            abs = fileStorage.GetAbsolutePath(file.StoragePath);
        }
        else if (!string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            var full = Path.GetFullPath(file.ExternalPath);

            var allowedRoots = await db.LocalFolders
                .AsNoTracking()
                .Where(f => f.Enabled)
                .Select(f => f.RootPath)
                .ToListAsync(cancellationToken);

            var allowed = allowedRoots.Any(root =>
            {
                if (string.IsNullOrWhiteSpace(root))
                {
                    return false;
                }

                var rootFull = Path.GetFullPath(root);
                if (!rootFull.EndsWith(Path.DirectorySeparatorChar))
                {
                    rootFull += Path.DirectorySeparatorChar;
                }
                return full.StartsWith(rootFull, StringComparison.Ordinal);
            });

            if (!allowed)
            {
                return NotFound();
            }

            abs = full;
        }

        if (string.IsNullOrWhiteSpace(abs) || !System.IO.File.Exists(abs))
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store";
        return PhysicalFile(abs, "application/octet-stream", enableRangeProcessing: true);
    }

    private const string NosebleedViewerCookieName = "games_vault_nosebleed_viewer";

    private string GetOrCreateNosebleedViewerId()
    {
        if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var existing)
            && Guid.TryParse(existing, out _))
        {
            return existing;
        }

        var id = Guid.NewGuid().ToString("N");
        Response.Cookies.Append(NosebleedViewerCookieName, id, new CookieOptions
        {
            Path = "/",
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = Request.IsHttps,
            MaxAge = TimeSpan.FromDays(30)
        });
        return id;
    }

    private async Task<string?> ResolveGameFileAbsolutePathAsync(GameFile file, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            return fileStorage.GetAbsolutePath(file.StoragePath);
        }

        if (string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            return null;
        }

        var full = Path.GetFullPath(file.ExternalPath);
        var allowedRoots = await db.LocalFolders
            .AsNoTracking()
            .Where(f => f.Enabled)
            .Select(f => f.RootPath)
            .ToListAsync(cancellationToken);

        var allowed = allowedRoots.Any(root =>
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                return false;
            }

            var rootFull = Path.GetFullPath(root);
            if (!rootFull.EndsWith(Path.DirectorySeparatorChar))
            {
                rootFull += Path.DirectorySeparatorChar;
            }
            return full.StartsWith(rootFull, StringComparison.Ordinal);
        });

        return allowed ? full : null;
    }

    private static bool IsWebPlayerAssetsPresent(WebPlayerOptions options, IWebHostEnvironment env)
    {
        var basePath = string.IsNullOrWhiteSpace(options.BasePath) ? "/webplayer" : options.BasePath.TrimEnd('/');
        basePath = basePath.TrimStart('/');
        if (string.IsNullOrWhiteSpace(env.WebRootPath))
        {
            return false;
        }

        var root = Path.GetFullPath(env.WebRootPath);
        var indexPath = Path.Combine(root, basePath, "index.html");
        return System.IO.File.Exists(indexPath);
    }

    private static string? ResolveWebPlayerCoreKey(WebPlayerOptions options, Game game, GameFile? file)
    {
        if (options.SystemCores.TryGetValue(game.SystemName, out var mapped) && !string.IsNullOrWhiteSpace(mapped))
        {
            return mapped.Trim();
        }

        var name = file?.Name ?? "";
        var ext = Path.GetExtension(name);
        if (string.IsNullOrWhiteSpace(ext))
        {
            return null;
        }

        // Minimal fallback mapping (best-effort). Prefer explicit SystemCores config.
        var lower = ext.ToLowerInvariant();
        return lower switch
        {
            ".nes" => "fceumm",
            ".gb" => "gambatte",
            ".gbc" => "gambatte",
            ".gba" => "mgba",
            ".sfc" => "snes9x",
            ".smc" => "snes9x",
            ".gen" => "genesis_plus_gx",
            ".md" => "genesis_plus_gx",
            ".sms" => "genesis_plus_gx",
            ".gg" => "genesis_plus_gx",
            _ => null
        };
    }

    [HttpGet]
    public IActionResult Create(
        Guid? sessionId,
        int? networkShareId,
        string? networkQuery,
        Guid? webSessionId,
        int? webSourceId,
        string? webQuery,
        Guid? localSessionId,
        int? localFolderId,
        string? localQuery,
        CancellationToken cancellationToken)
    {
        // This route now exists primarily as a POST endpoint for file uploads.
        // Redirect GET requests back to the games list and open the add-game modal.
        return RedirectToAction(nameof(Index), new
        {
            openAdd = true,
            sessionId,
            networkShareId,
            networkQuery,
            webSessionId,
            webSourceId,
            webQuery,
            localSessionId,
            localFolderId,
            localQuery
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartLibretroSync(CancellationToken cancellationToken)
    {
        var jobId = await internalJobs.EnqueueLibretroSyncAsync(cancellationToken: cancellationToken);
        TempData["Message"] = $"Started libretro sync job #{jobId}.";
        return RedirectToAction(nameof(Index), new { openAdd = true });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(GameUploadCreateViewModel model, CancellationToken cancellationToken)
    {
        model.LibretroAvailable = libretroStore.HasDatFiles();

        async Task<GameUploadCreateViewModel> RebuildForViewAsync()
        {
            var rebuilt = await BuildGameUploadCreateViewModelAsync(
                model.NetworkScanSessionId == Guid.Empty ? null : model.NetworkScanSessionId,
                model.SelectedNetworkShareId,
                model.NetworkQuery,
                model.WebScanSessionId == Guid.Empty ? null : model.WebScanSessionId,
                model.SelectedWebSourceId,
                model.WebQuery,
                model.LocalScanSessionId == Guid.Empty ? null : model.LocalScanSessionId,
                model.SelectedLocalFolderId,
                model.LocalQuery,
                cancellationToken);

            rebuilt.Files = model.Files;
            return rebuilt;
        }

        if (!model.LibretroAvailable)
        {
            ModelState.AddModelError(string.Empty, "Libretro database is not available yet. Start a libretro sync job first.");
            return View(await RebuildForViewAsync());
        }

        if (!ModelState.IsValid)
        {
            return View(await RebuildForViewAsync());
        }

        try
        {
            var stagingDir = stagingStore.CreateStagingDirectory();
            try
            {
                await stagingStore.SaveAsync(model.Files, stagingDir, cancellationToken);
            }
            catch
            {
                stagingStore.TryDeleteDirectory(stagingDir);
                throw;
            }

            var jobId = await internalJobs.EnqueueUploadImportAsync(stagingDir, cancellationToken);
            TempData["Message"] = $"Queued import job #{jobId}. You can monitor it in Jobs.";
            return RedirectToAction(nameof(JobsController.Details), "Jobs", new { id = jobId });
        }
        catch (Exception ex)
        {
            ModelState.AddModelError(string.Empty, ex.Message);
            return View(await RebuildForViewAsync());
        }

    }

    public async Task<IActionResult> Edit(int id)
    {
        var game = await db.Games
            .Include(x => x.Files)
            .FirstOrDefaultAsync(x => x.Id == id);
        if (game is null)
        {
            return NotFound();
        }

        return View(game);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Edit(int id, Game game, string? returnUrl = null)
    {
        if (id != game.Id)
        {
            return BadRequest();
        }

        if (!ModelState.IsValid)
        {
            return View(game);
        }

        var existing = await db.Games.FindAsync(id);
        if (existing is null)
        {
            return NotFound();
        }

        existing.SystemName = game.SystemName;
        existing.Name = game.Name;
        existing.ReleaseDate = game.ReleaseDate;
        existing.NumberOfPlayers = game.NumberOfPlayers;
        existing.Genre = game.Genre;
        existing.CriticRating = game.CriticRating;
        existing.UserRating = game.UserRating;
        existing.CriticGenre = game.CriticGenre;

        await db.SaveChangesAsync();

        TempData["Message"] = "Game updated.";
        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            return Redirect(returnUrl);
        }

        return RedirectToAction(nameof(Details), new { id = game.Id });
    }

    public async Task<IActionResult> Delete(int id)
    {
        var game = await db.Games
            .Include(x => x.Files)
            .FirstOrDefaultAsync(x => x.Id == id);
        if (game is null)
        {
            return NotFound();
        }

        return View(game);
    }

    [HttpPost, ActionName(nameof(Delete))]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteConfirmed(int id)
    {
        var game = await db.Games.FindAsync(id);
        if (game is null)
        {
            return RedirectToAction(nameof(Index));
        }

        db.Games.Remove(game);
        await db.SaveChangesAsync();

        return RedirectToAction(nameof(Index));
    }
}
