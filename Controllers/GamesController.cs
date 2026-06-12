using games_vault.Data;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.BackgroundJobs;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Globalization;

namespace games_vault.Controllers;

public class GamesController(
    AppDbContext db,
    UploadStagingStore stagingStore,
    LibretroDatabaseStore libretroStore,
    SystemDatIndexProvider systemDat,
    SystemFileStorage systemFileStorage,
    GameUploadImporter uploadImporter,
    LibretroDatabaseSyncService libretroSync,
    GameFileStorage fileStorage,
    CurrentProfileService currentProfile,
    CurrentAccessService currentAccess) : Controller
{
    public async Task<IActionResult> Index(
        [FromQuery] GamesLibraryBrowseQuery browse,
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
        var bank = await BuildGamesBankAsync(browse, batchId, cancellationToken);

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
                    Browse = bank.Browse,
                    Query = bank.Query,
                    Page = bank.Page,
                    PageSize = bank.PageSize,
                    TotalCount = bank.TotalCount,
                    SystemOptions = bank.SystemOptions,
                    PlayerOptions = bank.PlayerOptions,
                    Sections = bank.Sections,
                    ActiveGameIds = bank.ActiveGameIds,
                    ActiveRoomsByGameId = bank.ActiveRoomsByGameId,
                    CanManageLibrary = bank.CanManageLibrary,
                    BatchId = null,
                    BatchGameIds = Array.Empty<int>(),
                    MissingSystemFilesBySystem = bank.MissingSystemFilesBySystem
                };
            }
        }

        ViewData["ReturnUrl"] = Url.Action(nameof(Index), new
        {
            q = bank.Browse.Q,
            system = bank.Browse.System,
            players = bank.Browse.Players,
            playingNow = bank.Browse.PlayingNow ? true : (bool?)null,
            sort = bank.Browse.Sort,
            group = bank.Browse.Group,
            page = bank.Page,
            pageSize = bank.PageSize,
            batchId = bank.BatchId,
            batchPage,
            batchPageSize
        });

        return View(new GamesIndexViewModel
        {
            Games = bank.Games,
            Browse = bank.Browse,
            Query = bank.Query,
            Page = bank.Page,
            PageSize = bank.PageSize,
            TotalCount = bank.TotalCount,
            SystemCount = bank.SystemOptions.Count,
            ActiveNowCount = bank.ActiveGameIds.Count,
            PlayedThisWeekCount = await db.GamePlaySessions.AsNoTracking().Where(s => s.StartedUtc >= DateTime.UtcNow.AddDays(-7)).Select(s => s.GameId).Distinct().CountAsync(cancellationToken),
            SystemOptions = bank.SystemOptions,
            PlayerOptions = bank.PlayerOptions,
            Sections = bank.Sections,
            ActiveGameIds = bank.ActiveGameIds,
            ActiveRoomsByGameId = bank.ActiveRoomsByGameId,
            CanManageLibrary = bank.CanManageLibrary,
            BatchId = bank.BatchId,
            BatchName = activeBatchName,
            SavedBatches = savedBatches,
            BatchGames = batchGames,
            BatchGameIds = bank.BatchGameIds,
            BatchPage = batchPage,
            BatchPageSize = batchPageSize,
            BatchTotalCount = batchTotalCount,
            AddGame = new games_vault.Models.ViewModels.GameUploadCreateViewModel
            {
                LibretroAvailable = libretroStore.HasDatFiles(),
                NetworkShares = await db.NetworkShares.AsNoTracking().OrderBy(x => x.Name).ToListAsync(cancellationToken),
                WebSources = await db.WebSources.AsNoTracking().OrderBy(x => x.Name).ToListAsync(cancellationToken),
                LocalFolders = await db.LocalFolders.AsNoTracking().OrderBy(x => x.Name).ToListAsync(cancellationToken),
            },
            MissingSystemFilesBySystem = bank.MissingSystemFilesBySystem
        });
    }

    [HttpGet]
    public async Task<IActionResult> Bank([FromQuery] GamesLibraryBrowseQuery browse, int? batchId = null, CancellationToken cancellationToken = default)
    {
        Response.Headers.CacheControl = "no-store";

        var bank = await BuildGamesBankAsync(browse, batchId, cancellationToken);
        Response.Headers["X-Games-TotalCount"] = bank.TotalCount.ToString(CultureInfo.InvariantCulture);

        ViewData["ReturnUrl"] = Url.Action(nameof(Index), new
        {
            q = bank.Browse.Q,
            system = bank.Browse.System,
            players = bank.Browse.Players,
            playingNow = bank.Browse.PlayingNow ? true : (bool?)null,
            sort = bank.Browse.Sort,
            group = bank.Browse.Group,
            page = bank.Page,
            pageSize = bank.PageSize,
            batchId = bank.BatchId
        }) ?? "/Games";
        return PartialView("_GamesBank", bank);
    }

    [HttpPost("Games/TogglePin/{id}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> TogglePin(int id, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.CanPlayAsync(cancellationToken))
        {
            return Json(new { error = "Sign in to pin games." });
        }

        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null)
        {
            return Json(new { error = "Sign in to pin games." });
        }

        var gameExists = await db.Games.AnyAsync(x => x.Id == id, cancellationToken);
        if (!gameExists)
        {
            return NotFound();
        }

        var existing = await db.ProfilePinnedGames
            .FirstOrDefaultAsync(x => x.ProfileId == profile.Id && x.GameId == id, cancellationToken);

        bool pinned;
        if (existing is not null)
        {
            if (existing.IsArchived)
            {
                existing.IsArchived = false;
                pinned = true;
            }
            else
            {
                existing.IsArchived = true;
                pinned = false;
            }
        }
        else
        {
            db.ProfilePinnedGames.Add(new ProfilePinnedGame
            {
                ProfileId = profile.Id,
                GameId = id,
                CreatedUtc = DateTime.UtcNow
            });
            pinned = true;
        }

        await db.SaveChangesAsync(cancellationToken);
        return Json(new { pinned });
    }

    private IQueryable<Game> ApplyGamesLibrarySearch(IQueryable<Game> query, string? q)
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            return query;
        }

        var qLower = q.Trim().ToLower();
        return query.Where(g =>
            g.Name.ToLower().Contains(qLower) ||
            g.SystemName.ToLower().Contains(qLower) ||
            g.Files.Any(f =>
                f.Name.ToLower().Contains(qLower) ||
                (f.Crc32 != null && f.Crc32.ToLower().Contains(qLower))));
    }

    private IQueryable<Game> ApplyGamesLibraryPlayingNowFilter(IQueryable<Game> query)
    {
        return query.Where(g =>
            db.GamePlayRooms.Any(r => r.GameId == g.Id && r.Status == GamePlayRoomStatus.Active && r.NosebleedSessionId != null) ||
            db.ArcadeCabinets.Any(c => c.GameId == g.Id && c.IsEnabled && c.RuntimeSessionId != null));
    }

    private async Task<GamesBankViewModel> BuildGamesBankAsync(GamesLibraryBrowseQuery? browse, int? batchId, CancellationToken cancellationToken)
    {
        browse = (browse ?? new GamesLibraryBrowseQuery()).Normalize();
        var page = browse.Page;
        var pageSize = browse.PageSize;
        batchId = batchId is > 0 ? batchId : null;

        var searchedQuery = ApplyGamesLibrarySearch(db.Games.AsNoTracking(), browse.Q);

        var systemOptionRows = await searchedQuery
            .Where(g => g.SystemName != "")
            .GroupBy(g => g.SystemName)
            .Select(g => new { Name = g.Key, Count = g.Count() })
            .OrderBy(g => g.Name)
            .ToListAsync(cancellationToken);
        var systemOptions = systemOptionRows
            .Select(g => new GamesLibrarySystemOption(g.Name, g.Count))
            .ToList();

        var playerOptionRows = await searchedQuery
            .Where(g => g.NumberOfPlayers != null)
            .GroupBy(g => g.NumberOfPlayers!.Value)
            .Select(g => new { Players = g.Key, Count = g.Count() })
            .OrderBy(g => g.Players)
            .ToListAsync(cancellationToken);
        var playerOptions = playerOptionRows
            .Select(g => new GamesLibraryPlayerCountOption(g.Players, g.Count))
            .ToList();

        var query = searchedQuery;

        if (!string.IsNullOrWhiteSpace(browse.System))
        {
            var systemLower = browse.System.ToLower();
            query = query.Where(g => g.SystemName.ToLower() == systemLower);
        }

        if (browse.Players is > 0)
        {
            query = query.Where(g => g.NumberOfPlayers == browse.Players.Value);
        }

        if (browse.PlayingNow)
        {
            query = ApplyGamesLibraryPlayingNowFilter(query);
        }

        var weekStartUtc = DateTime.UtcNow.AddDays(-7);
        query = browse.Sort switch
        {
            GamesLibrarySort.AlphabeticalAsc => query.OrderBy(g => g.Name),
            GamesLibrarySort.AlphabeticalDesc => query.OrderByDescending(g => g.Name),
            GamesLibrarySort.System => query.OrderBy(g => g.SystemName).ThenBy(g => g.Name),
            GamesLibrarySort.NumberOfPlayers => query.OrderByDescending(g => g.NumberOfPlayers ?? 0).ThenBy(g => g.Name),
            GamesLibrarySort.RecentlyPlayed => query
                .GroupJoin(db.GamePlaySessions, g => g.Id, s => s.GameId,
                    (g, sessions) => new { Game = g, MaxStarted = sessions.Max(s => (DateTime?)s.StartedUtc) })
                .OrderByDescending(x => x.MaxStarted ?? x.Game.CreatedUtc)
                .ThenBy(x => x.Game.Name)
                .Select(x => x.Game),
            GamesLibrarySort.MostPlayedAllTime => query
                .GroupJoin(db.GamePlaySessions, g => g.Id, s => s.GameId,
                    (g, sessions) => new { Game = g, PlayCount = sessions.Count() })
                .OrderByDescending(x => x.PlayCount)
                .ThenBy(x => x.Game.Name)
                .Select(x => x.Game),
            GamesLibrarySort.MostPlayedThisWeek => query
                .GroupJoin(db.GamePlaySessions, g => g.Id, s => s.GameId,
                    (g, sessions) => new { Game = g, PlayCount = sessions.Count(s => s.StartedUtc >= weekStartUtc) })
                .OrderByDescending(x => x.PlayCount)
                .ThenBy(x => x.Game.Name)
                .Select(x => x.Game),
            _ => query.OrderByDescending(g => g.CreatedUtc)
        };

        var totalCount = await query.CountAsync(cancellationToken);

        var games = await query
            .Include(x => x.Files)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        var pageGameIds = games.Select(g => g.Id).ToArray();

        var activeGameIds = pageGameIds.Length == 0
            ? new HashSet<int>()
            : (await db.GamePlayRooms
                .AsNoTracking()
                .Where(r =>
                    pageGameIds.Contains(r.GameId) &&
                    r.Status == GamePlayRoomStatus.Active &&
                    r.NosebleedSessionId != null)
                .Select(r => r.GameId)
                .Concat(db.ArcadeCabinets
                    .AsNoTracking()
                    .Where(c =>
                        pageGameIds.Contains(c.GameId) &&
                        c.IsEnabled &&
                        c.RuntimeSessionId != null)
                    .Select(c => c.GameId))
                .Distinct()
                .ToListAsync(cancellationToken))
            .ToHashSet();

        var activeRoomsByGameId = pageGameIds.Length == 0
            ? new Dictionary<int, IReadOnlyList<GamesLibraryActiveRoomOption>>()
            : (await db.GamePlayRooms
                .AsNoTracking()
                .Where(r =>
                    pageGameIds.Contains(r.GameId) &&
                    r.Status == GamePlayRoomStatus.Active &&
                    r.NosebleedSessionId != null)
                .OrderByDescending(r => r.LastActiveUtc)
                .Select(r => new
                {
                    r.GameId,
                    r.Code,
                    CreatedByProfileName = r.CreatedByProfile != null ? r.CreatedByProfile.DisplayName : null,
                    PlayerProfileName = r.Participants
                        .Where(p => p.Role == GamePlayRoomParticipantRole.Player && p.Profile != null)
                        .OrderByDescending(p => p.IsConnected)
                        .ThenBy(p => p.JoinedUtc)
                        .Select(p => p.Profile!.DisplayName)
                        .FirstOrDefault(),
                    PlayerDisplayName = r.Participants
                        .Where(p => p.Role == GamePlayRoomParticipantRole.Player && p.DisplayNameSnapshot != null && p.DisplayNameSnapshot != "")
                        .OrderByDescending(p => p.IsConnected)
                        .ThenBy(p => p.JoinedUtc)
                        .Select(p => p.DisplayNameSnapshot)
                        .FirstOrDefault()
                })
                .ToListAsync(cancellationToken))
            .GroupBy(r => r.GameId)
            .ToDictionary(
                g => g.Key,
                g => (IReadOnlyList<GamesLibraryActiveRoomOption>)g
                    .Select(r => new GamesLibraryActiveRoomOption(
                        r.Code,
                        r.PlayerProfileName ?? r.PlayerDisplayName ?? r.CreatedByProfileName ?? "Player"))
                    .ToList());

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

        var sections = BuildGamesLibrarySections(games, browse.Group, activeGameIds);
        var canManageLibrary = await currentAccess.CanManageLibraryAsync(cancellationToken);

        var currentUser = await currentProfile.GetCurrentAsync(cancellationToken);
        var pinnedGameIds = currentUser is not null
            ? (await db.ProfilePinnedGames
                .AsNoTracking()
                .Where(x => x.ProfileId == currentUser.Id && !x.IsArchived)
                .Select(x => x.GameId)
                .ToListAsync(cancellationToken))
                .ToHashSet()
            : new HashSet<int>();

        return new GamesBankViewModel
        {
            Games = games,
            Browse = browse,
            Query = browse.Q,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount,
            SystemOptions = systemOptions,
            PlayerOptions = playerOptions,
            Sections = sections,
            ActiveGameIds = activeGameIds,
            ActiveRoomsByGameId = activeRoomsByGameId,
            CanManageLibrary = canManageLibrary,
            BatchId = batchId,
            BatchGameIds = batchGameIds,
            MissingSystemFilesBySystem = missingBySystem,
            PinnedGameIds = pinnedGameIds
        };
    }

    private static IReadOnlyList<GamesLibraryGroupSection> BuildGamesLibrarySections(
        IReadOnlyList<Game> games,
        GamesLibraryGroup group,
        IReadOnlySet<int> activeGameIds)
    {
        if (games.Count == 0)
        {
            return Array.Empty<GamesLibraryGroupSection>();
        }

        return group switch
        {
            GamesLibraryGroup.System => games
                .GroupBy(g => string.IsNullOrWhiteSpace(g.SystemName) ? "Unknown system" : g.SystemName)
                .Select(g => new GamesLibraryGroupSection(g.Key, g.ToList()))
                .ToList(),
            GamesLibraryGroup.Alphabetical => games
                .GroupBy(g => !string.IsNullOrWhiteSpace(g.Name) && char.IsLetter(g.Name[0]) ? char.ToUpperInvariant(g.Name[0]).ToString() : "#")
                .Select(g => new GamesLibraryGroupSection(g.Key, g.ToList()))
                .ToList(),
            GamesLibraryGroup.NumberOfPlayers => games
                .GroupBy(g => g.NumberOfPlayers is > 0 ? $"{g.NumberOfPlayers} player{(g.NumberOfPlayers == 1 ? "" : "s")}" : "Unknown players")
                .Select(g => new GamesLibraryGroupSection(g.Key, g.ToList()))
                .ToList(),
            GamesLibraryGroup.CurrentlyPlaying => games
                .GroupBy(g => activeGameIds.Contains(g.Id) ? "Playing now" : "Not currently playing")
                .OrderBy(g => g.Key == "Playing now" ? 0 : 1)
                .Select(g => new GamesLibraryGroupSection(g.Key, g.ToList()))
                .ToList(),
            _ => [new GamesLibraryGroupSection(null, games)]
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

    public async Task<IActionResult> Details(
        int id,
        int filePage = 1,
        int filePageSize = 50,
        CancellationToken cancellationToken = default)
    {
        filePage = Math.Max(1, filePage);
        filePageSize = Math.Clamp(filePageSize, 10, 100);

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

        return View(new games_vault.Models.ViewModels.GameDetailsViewModel
        {
            Game = game,
            Files = files,
            FilePage = filePage,
            FilePageSize = filePageSize,
            FileTotalCount = totalCount
        });
    }

    [HttpGet]
    public async Task<IActionResult> Rom(int id, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.CanPlayAsync(cancellationToken))
        {
            return Forbid();
        }

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
        await libretroSync.SyncAsync(cancellationToken: cancellationToken);
        TempData["Message"] = "Libretro database sync complete.";
        return RedirectToAction(nameof(Index), new { openAdd = true });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(GameUploadCreateViewModel model, CancellationToken cancellationToken)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken)) return Forbid();
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

            var result = await uploadImporter.ImportFromStagedDirectoryAsync(stagingDir, cancellationToken);
            TempData["Message"] = $"Imported {result.Groups.Count} game(s) with {result.TotalMatchedFileCount} matched files.";
            return RedirectToAction(nameof(Index));
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
    public async Task<IActionResult> Edit(int id,
        [Bind("SystemName,Name,ReleaseDate,NumberOfPlayers,Genre,CriticRating,UserRating,CriticGenre")] Game game,
        string? returnUrl = null)
    {
        if (!await currentAccess.IsAdminAsync(HttpContext.RequestAborted)) return Forbid();
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
        if (!await currentAccess.IsAdminAsync(HttpContext.RequestAborted)) return Forbid();
        var game = await db.Games.FindAsync(id);
        if (game is null)
        {
            return RedirectToAction(nameof(Index));
        }

        db.Games.Remove(game);
        await db.SaveChangesAsync();

        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> GeneratePreview(int id, bool force = false)
    {
        if (!await currentAccess.IsAdminAsync(HttpContext.RequestAborted)) return Forbid();

        var jobs = HttpContext.RequestServices.GetRequiredService<IBackgroundJobClient>();
        var jobId = await jobs.EnqueueAsync("preview.generate", new BackgroundJobs.Commands.GeneratePreviewJobPayload(id, force));

        TempData["Message"] = $"Preview generation job #{jobId} queued for game #{id}.";
        return RedirectToAction(nameof(Edit), new { id });
    }
}
