using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Models;
using games_vault.Profiles;
using games_vault.Web;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using System.Globalization;

namespace games_vault.Controllers;

[AutoValidateAntiforgeryToken]
[ServiceFilter(typeof(AdminOnlyFilter))]
public class ImportController(
    AppDbContext db,
    CurrentAccessService currentAccess,
    IInternalJobsClient internalJobs) : Controller
{
    [HttpPost]
    public async Task<IActionResult> CreateBatch(string name, string? returnUrl, CancellationToken cancellationToken)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken)) return Forbid();
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

        return RedirectToAction(nameof(GamesController.Index), "Games", new { batchId = batch.Id });
    }

    [HttpPost]
    public async Task<IActionResult> RenameBatch(int batchId, string? name, string? returnUrl, CancellationToken cancellationToken)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken)) return Forbid();
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

        return RedirectToAction(nameof(GamesController.Index), "Games", new { batchId });
    }

    [HttpPost]
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

        return RedirectToAction(nameof(GamesController.Index), "Games", new { batchId = effectiveBatchId });
    }

    [HttpPost]
    public async Task<IActionResult> DeleteBatch(int batchId, string? returnUrl, CancellationToken cancellationToken)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken)) return Forbid();
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

        return RedirectToAction(nameof(GamesController.Index), "Games");
    }

    [HttpPost]
    public async Task<IActionResult> AddSelectedToBatch(int[] ids, int? batchId, string? returnUrl, CancellationToken cancellationToken)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken)) return Forbid();
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

        return RedirectToAction(nameof(GamesController.Index), "Games", new { batchId = effectiveBatchId });
    }

    [HttpPost]
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

    [HttpPost]
    public async Task<IActionResult> BulkDelete(int[] ids, string? q, int page = 1, int pageSize = 25, int? batchId = null, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken)) return Forbid();
        if (ids.Length == 0)
        {
            TempData["Message"] = "No games selected.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { q, page, pageSize, batchId });
        }

        var games = await db.Games
            .Where(g => ids.Contains(g.Id))
            .ToListAsync(cancellationToken);

        db.Games.RemoveRange(games);
        await db.SaveChangesAsync(cancellationToken);

        TempData["Message"] = $"Deleted {games.Count} game(s).";
        return RedirectToAction(nameof(GamesController.Index), "Games", new { q, page, pageSize, batchId });
    }

    private IActionResult RedirectToLocalOrIndex(string? returnUrl)
    {
        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            return Redirect(returnUrl);
        }

        return RedirectToAction(nameof(GamesController.Index), "Games");
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
}
