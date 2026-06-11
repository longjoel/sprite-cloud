using games_vault.Arcade;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.Controllers;

public class ArcadeController(
    AppDbContext db,
    ArcadeGameFileResolver fileResolver,
    NosebleedSessionManager nosebleedSessions,
    NosebleedSeatManager nosebleedSeats,
    GamePlayTelemetryService gamePlayTelemetry,
    GamePlayRoomService roomService,
    CurrentProfileService currentProfile,
    CurrentAccessService currentAccess,
    IOptions<NosebleedOptions> nosebleedOptions) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        nosebleedSessions.Cleanup();
        var canManage = await currentAccess.CanManageLibraryAsync(cancellationToken);
        var canPlay = await currentAccess.CanPlayAsync(cancellationToken);
        var arcade = await db.Arcades
            .AsNoTracking()
            .OrderBy(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);

        var sessions = nosebleedSessions.GetSessions()
            .ToDictionary(x => x.SessionId, StringComparer.OrdinalIgnoreCase);

        var cabinets = arcade is null
            ? new List<ArcadeCabinetViewModel>()
            : await db.ArcadeCabinets
                .AsNoTracking()
                .Include(x => x.Game)
                .Where(x => x.ArcadeId == arcade.Id)
                .OrderBy(x => x.SortOrder)
                .ThenBy(x => x.Id)
                .Select(x => new ArcadeCabinetViewModel
                {
                    Id = x.Id,
                    DisplayName = x.DisplayName,
                    GameId = x.GameId,
                    GameName = x.Game.Name,
                    SystemName = x.Game.SystemName,
                    IsEnabled = x.IsEnabled,
                    AutoRestart = x.AutoRestart,
                    CreditMode = x.CreditMode == ArcadeCabinetCreditMode.FreePlay ? "Free Play" : $"{x.TokenCostPerCredit} token / credit",
                    RuntimeSessionId = x.RuntimeSessionId,
                    LastStartedUtc = x.LastStartedUtc,
                    LastSeenAliveUtc = x.LastSeenAliveUtc,
                    LastError = x.LastError
                })
                .ToListAsync(cancellationToken);

        foreach (var cabinet in cabinets)
        {
            if (!string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId)
                && sessions.TryGetValue(cabinet.RuntimeSessionId, out var session)
                && !session.HasExited)
            {
                cabinet.Session = session;
                cabinet.PlayerCount = nosebleedSeats.GetAssignments(session.SessionId, DateTimeOffset.UtcNow)
                    .Count(x => x.Kind == NosebleedSeatKind.Player);
            }
        }

        var gamePicker = canManage
            ? await BuildGamePickerAsync(new ArcadeGamePickerQuery { PageSize = 10 }, cancellationToken)
            : new ArcadeGamePickerViewModel();

        return View(new ArcadeIndexViewModel
        {
            Arcade = arcade,
            Cabinets = cabinets,
            GamePicker = gamePicker,
            CanManage = canManage,
            CanPlay = canPlay,
            NosebleedEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled
        });
    }

    [HttpGet]
    public async Task<IActionResult> GamePicker([FromQuery] ArcadeGamePickerQuery query, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return StatusCode(StatusCodes.Status403Forbidden);

        var model = await BuildGamePickerAsync(query, cancellationToken);
        Response.Headers.CacheControl = "no-store";
        return PartialView("_GamePickerResults", model);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateDefault(CancellationToken cancellationToken)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return Forbid();
        if (!await db.Arcades.AnyAsync(cancellationToken))
        {
            db.Arcades.Add(new Models.Arcade
            {
                Name = "Free Play Arcade",
                Slug = "free-play",
                Description = "Persistent free-play cabinets that keep running even when nobody is connected.",
                IsEnabled = true,
                CreatedUtc = DateTime.UtcNow
            });
            await db.SaveChangesAsync(cancellationToken);
            TempData["Message"] = "Created the Free Play Arcade.";
        }
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddCabinet(int gameId, string? displayName, CancellationToken cancellationToken)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return Forbid();
        var arcade = await EnsureDefaultArcadeAsync(cancellationToken);
        var game = await db.Games.Include(x => x.Files).FirstOrDefaultAsync(x => x.Id == gameId, cancellationToken);
        if (game is null)
        {
            TempData["Message"] = "Game not found.";
            return RedirectToAction(nameof(Index));
        }
        var file = game.Files.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f.StoragePath) || !string.IsNullOrWhiteSpace(f.ExternalPath));
        if (file is null)
        {
            TempData["Message"] = "That game has no stored or linked ROM file.";
            return RedirectToAction(nameof(Index));
        }
        var nextSort = await db.ArcadeCabinets.Where(x => x.ArcadeId == arcade.Id).Select(x => (int?)x.SortOrder).MaxAsync(cancellationToken) ?? 0;
        var cabinet = new ArcadeCabinet
        {
            ArcadeId = arcade.Id,
            GameId = game.Id,
            GameFileId = file.Id,
            DisplayName = string.IsNullOrWhiteSpace(displayName) ? game.Name : displayName.Trim()[..Math.Min(displayName.Trim().Length, 120)],
            SortOrder = nextSort + 10,
            IsEnabled = true,
            AutoRestart = true,
            CreditMode = ArcadeCabinetCreditMode.FreePlay,
            TokenCostPerCredit = 0,
            CreatedUtc = DateTime.UtcNow
        };
        db.ArcadeCabinets.Add(cabinet);
        await db.SaveChangesAsync(cancellationToken);
        TempData["Message"] = $"Added {cabinet.DisplayName} as a free-play cabinet. The supervisor will boot it automatically.";
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartCabinet(int id, CancellationToken cancellationToken)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return Forbid();
        var cabinet = await db.ArcadeCabinets.Include(x => x.Game).FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (cabinet is null) return NotFound();
        cabinet.IsEnabled = true;
        cabinet.AutoRestart = true;
        cabinet.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        await EnsureCabinetRunningAsync(cabinet, cancellationToken);
        TempData["Message"] = $"Started {cabinet.DisplayName}.";
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StopCabinet(int id, CancellationToken cancellationToken)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return Forbid();
        var cabinet = await db.ArcadeCabinets.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (cabinet is null) return NotFound();
        cabinet.AutoRestart = false;
        cabinet.IsEnabled = false;
        if (!string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId))
        {
            nosebleedSessions.TryStop(cabinet.RuntimeSessionId, "arcade cabinet stopped");
        }
        cabinet.RuntimeSessionId = null;
        cabinet.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        TempData["Message"] = $"Stopped {cabinet.DisplayName}.";
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RestartCabinet(int id, CancellationToken cancellationToken)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return Forbid();
        var cabinet = await db.ArcadeCabinets.Include(x => x.Game).FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (cabinet is null) return NotFound();
        if (!string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId))
        {
            nosebleedSessions.TryStop(cabinet.RuntimeSessionId, "arcade cabinet restart");
        }
        cabinet.RuntimeSessionId = null;
        cabinet.LastStartedUtc = null;
        cabinet.IsEnabled = true;
        cabinet.AutoRestart = true;
        cabinet.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        await EnsureCabinetRunningAsync(cabinet, cancellationToken);
        TempData["Message"] = $"Restarted {cabinet.DisplayName}.";
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RemoveCabinet(int id, CancellationToken cancellationToken)
    {
        if (!await currentAccess.CanManageLibraryAsync(cancellationToken)) return Forbid();
        var cabinet = await db.ArcadeCabinets.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (cabinet is null) return NotFound();

        var displayName = cabinet.DisplayName;
        if (!string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId))
        {
            nosebleedSessions.TryStop(cabinet.RuntimeSessionId, "arcade cabinet removed");
            await gamePlayTelemetry.FinishByExternalSessionAsync(cabinet.RuntimeSessionId, "arcade cabinet removed", cancellationToken);
        }

        db.ArcadeCabinets.Remove(cabinet);
        await db.SaveChangesAsync(cancellationToken);
        TempData["Message"] = $"Removed {displayName} from the arcade.";
        return RedirectToAction(nameof(Index));
    }

    [HttpGet]
    public async Task<IActionResult> Join(int id, CancellationToken cancellationToken = default)
    {
        var cabinet = await db.ArcadeCabinets
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .FirstOrDefaultAsync(x => x.Id == id && x.IsEnabled && x.Arcade.IsEnabled, cancellationToken);
        if (cabinet is null) return NotFound();

        var session = await EnsureCabinetRunningAsync(cabinet, cancellationToken);
        if (session is null)
        {
            return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
            {
                Game = cabinet.Game,
                File = cabinet.GameFile,
                PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
                ShowRoomControls = false,
                Error = cabinet.LastError ?? "Cabinet is not running yet."
            });
        }

        var join = await roomService.JoinArcadeCabinetAsync(cabinet, session, GetOrCreateNosebleedViewerId(), cancellationToken);
        if (!join.Success || join.Room is null)
        {
            return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
            {
                Game = cabinet.Game,
                File = cabinet.GameFile,
                PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
                ShowRoomControls = false,
                Error = join.Error ?? "Cabinet session is unavailable right now."
            });
        }

        return RedirectToRoute("ArcadeRoom", new { code = join.Room.Code });
    }

    [HttpGet("/Arcade/{sessionId:regex(^games-vault-.+$)}", Name = "ArcadeSession")]
    public async Task<IActionResult> OpenSession(string sessionId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            TempData["Message"] = "That arcade session link is missing its session id.";
            return RedirectToAction(nameof(Index));
        }

        var cabinet = await db.ArcadeCabinets
            .Include(x => x.Arcade)
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .FirstOrDefaultAsync(
                x => x.RuntimeSessionId == sessionId && x.IsEnabled && x.Arcade.IsEnabled,
                cancellationToken);
        if (cabinet is null)
        {
            TempData["Message"] = "That arcade session link is stale. Open the cabinet again from the arcade floor.";
            return RedirectToAction(nameof(Index));
        }

        var sessionSnapshot = nosebleedSessions.GetSessions()
            .FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase) && !x.HasExited);
        NosebleedSession liveSession;
        if (sessionSnapshot is null)
        {
            var restartedSession = await EnsureCabinetRunningAsync(cabinet, cancellationToken);
            if (restartedSession is null)
            {
                return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
                {
                    Game = cabinet.Game,
                    File = cabinet.GameFile,
                    PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
                    ShowRoomControls = false,
                    Error = cabinet.LastError ?? "Cabinet is not running right now."
                });
            }

            liveSession = restartedSession;
        }
        else
        {
            liveSession = new NosebleedSession(
                sessionSnapshot.SessionId,
                sessionSnapshot.GameId,
                sessionSnapshot.FileId,
                sessionSnapshot.Port,
                sessionSnapshot.BaseUrl,
                sessionSnapshot.LocalUrl,
                string.Empty,
                sessionSnapshot.StartedUtc,
                sessionSnapshot.CorePath,
                sessionSnapshot.ContentPath);
        }

        var roomCode = await db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.NosebleedSessionId == sessionId && x.Status == GamePlayRoomStatus.Active && x.ArcadeCabinetId == cabinet.Id)
            .Select(x => x.Code)
            .FirstOrDefaultAsync(cancellationToken);
        if (!string.IsNullOrWhiteSpace(roomCode))
        {
            return RedirectToRoute("ArcadeRoom", new { code = roomCode });
        }

        return await BuildCabinetSessionViewAsync(cabinet, liveSession, cancellationToken);
    }

    [HttpGet("/Arcade/Room/{code}", Name = "ArcadeRoom")]
    public async Task<IActionResult> OpenRoom(string code, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            TempData["Message"] = "That arcade room link is missing its room code.";
            return RedirectToAction(nameof(Index));
        }

        var room = await db.GamePlayRooms
            .AsNoTracking()
            .Include(x => x.ArcadeCabinet)!
                .ThenInclude(x => x!.Arcade)
            .Include(x => x.ArcadeCabinet)!
                .ThenInclude(x => x!.Game)
            .Include(x => x.ArcadeCabinet)!
                .ThenInclude(x => x!.GameFile)
            .FirstOrDefaultAsync(
                x => x.Code == code.ToUpperInvariant()
                    && x.ArcadeCabinetId != null
                    && x.ArcadeCabinet != null
                    && x.ArcadeCabinet.IsEnabled
                    && x.ArcadeCabinet.Arcade.IsEnabled,
                cancellationToken);
        if (room?.ArcadeCabinet is null)
        {
            TempData["Message"] = "That arcade room link is stale. Open the cabinet again from the arcade floor.";
            return RedirectToAction(nameof(Index));
        }

        var session = await EnsureCabinetRunningAsync(room.ArcadeCabinet, cancellationToken);
        if (session is null)
        {
            return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
            {
                Game = room.ArcadeCabinet.Game,
                File = room.ArcadeCabinet.GameFile,
                PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
                ShowRoomControls = false,
                Error = room.ArcadeCabinet.LastError ?? "Cabinet is not running right now."
            });
        }

        return await BuildCabinetSessionViewAsync(room.ArcadeCabinet, session, cancellationToken);
    }

    private async Task<IActionResult> BuildCabinetSessionViewAsync(ArcadeCabinet cabinet, NosebleedSession session, CancellationToken cancellationToken)
    {
        if (cabinet.GameFile is null && cabinet.GameFileId is not null)
        {
            cabinet.GameFile = await db.GameFiles.FirstOrDefaultAsync(x => x.Id == cabinet.GameFileId.Value, cancellationToken);
        }

        var viewerId = GetOrCreateNosebleedViewerId();
        var join = await roomService.JoinArcadeCabinetAsync(cabinet, session, viewerId, cancellationToken);
        if (!join.Success || join.Room is null || join.Session is null)
        {
            return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
            {
                Game = cabinet.Game,
                File = cabinet.GameFile,
                PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
                ShowRoomControls = false,
                Error = join.Error ?? "Cabinet session is unavailable right now."
            });
        }

        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (join.Seat?.Kind == NosebleedSeatKind.Player)
        {
            await gamePlayTelemetry.StartAsync(cabinet.GameId, cabinet.GameFileId, "arcade-free-play", session.Id, profile?.Id, cancellationToken);
        }

        return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
        {
            Game = cabinet.Game,
            File = cabinet.GameFile,
            PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
            BaseUrl = join.Session.BaseUrl,
            SessionId = join.Session.Id,
            AssignedPort = join.Seat?.Port,
            PlayerNumber = join.Seat?.PlayerNumber,
            IsSpectator = join.Seat?.Kind != NosebleedSeatKind.Player,
            SeatExpiresUtc = join.Seat?.ExpiresUtc,
            CurrentRoomId = join.Room.Id,
            IsArcadeRoom = true,
            ShowRoomControls = false,
            CanChat = await currentAccess.CanChatAsync(cancellationToken),
            CurrentProfileDisplayName = profile?.DisplayName,
            CurrentProfileIsEphemeralGuest = profile?.IsEphemeral == true && profile.ParentProfileId is not null,
            CurrentProfileParentDisplayName = profile?.ParentProfile?.DisplayName,
            LeaveSessionReturnUrl = Url.Action(nameof(Index), "Arcade")
        });
    }

    private async Task<ArcadeGamePickerViewModel> BuildGamePickerAsync(ArcadeGamePickerQuery? query, CancellationToken cancellationToken)
    {
        var normalized = (query ?? new ArcadeGamePickerQuery()).Normalize();

        var playable = db.Games
            .AsNoTracking()
            .Where(g => g.Files.Any(f => f.StoragePath != null || f.ExternalPath != null));

        var searched = ApplyArcadeGamePickerSearch(playable, normalized.Q);

        var systemRows = await searched
            .Where(g => g.SystemName != "")
            .GroupBy(g => g.SystemName)
            .Select(g => new { Name = g.Key, Count = g.Count() })
            .OrderBy(g => g.Name)
            .ToListAsync(cancellationToken);
        var systemOptions = systemRows.Select(g => new ArcadeGamePickerSystemOption(g.Name, g.Count)).ToList();

        var playerRows = await searched
            .Where(g => g.NumberOfPlayers != null)
            .GroupBy(g => g.NumberOfPlayers!.Value)
            .Select(g => new { Players = g.Key, Count = g.Count() })
            .OrderBy(g => g.Players)
            .ToListAsync(cancellationToken);
        var playerOptions = playerRows.Select(g => new ArcadeGamePickerPlayerOption(g.Players, g.Count)).ToList();

        var filtered = searched;
        if (!string.IsNullOrWhiteSpace(normalized.System))
        {
            var systemLower = normalized.System.ToLower();
            filtered = filtered.Where(g => g.SystemName.ToLower() == systemLower);
        }

        if (normalized.Players is > 0)
        {
            filtered = filtered.Where(g => g.NumberOfPlayers == normalized.Players.Value);
        }

        filtered = normalized.Sort switch
        {
            ArcadeGamePickerSort.RecentlyAdded => filtered.OrderByDescending(g => g.CreatedUtc).ThenBy(g => g.Name),
            ArcadeGamePickerSort.System => filtered.OrderBy(g => g.SystemName).ThenBy(g => g.Name),
            ArcadeGamePickerSort.NumberOfPlayers => filtered.OrderByDescending(g => g.NumberOfPlayers ?? 0).ThenBy(g => g.Name),
            _ => filtered.OrderBy(g => g.Name)
        };

        var totalCount = await filtered.CountAsync(cancellationToken);
        var rows = await filtered
            .Skip((normalized.Page - 1) * normalized.PageSize)
            .Take(normalized.PageSize)
            .Select(g => new
            {
                g.Id,
                g.Name,
                g.SystemName,
                g.NumberOfPlayers,
                FileCount = g.Files.Count(f => f.StoragePath != null || f.ExternalPath != null),
                AlreadyCabinetCount = db.ArcadeCabinets.Count(c => c.GameId == g.Id)
            })
            .ToListAsync(cancellationToken);

        var games = rows.Select(g => new ArcadeGamePickerGameViewModel
        {
            Id = g.Id,
            Name = g.Name,
            SystemName = g.SystemName,
            NumberOfPlayers = g.NumberOfPlayers,
            FileCount = g.FileCount,
            AlreadyCabinetCount = g.AlreadyCabinetCount
        }).ToList();

        return new ArcadeGamePickerViewModel
        {
            Query = normalized,
            Games = games,
            SystemOptions = systemOptions,
            PlayerOptions = playerOptions,
            TotalCount = totalCount,
            Page = normalized.Page,
            PageSize = normalized.PageSize
        };
    }

    private static IQueryable<Game> ApplyArcadeGamePickerSearch(IQueryable<Game> query, string? q)
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            return query;
        }

        var qLower = q.Trim().ToLower();
        return query.Where(g =>
            g.Name.ToLower().Contains(qLower)
            || g.SystemName.ToLower().Contains(qLower)
            || g.Files.Any(f =>
                f.Name.ToLower().Contains(qLower)
                || (f.Crc32 != null && f.Crc32.ToLower().Contains(qLower))));
    }

    private async Task<Models.Arcade> EnsureDefaultArcadeAsync(CancellationToken cancellationToken)
    {
        var arcade = await db.Arcades.OrderBy(x => x.Id).FirstOrDefaultAsync(cancellationToken);
        if (arcade is not null) return arcade;
        arcade = new Models.Arcade
        {
            Name = "Free Play Arcade",
            Slug = "free-play",
            Description = "Persistent free-play cabinets that keep running even when nobody is connected.",
            CreatedUtc = DateTime.UtcNow
        };
        db.Arcades.Add(arcade);
        await db.SaveChangesAsync(cancellationToken);
        return arcade;
    }

    private async Task<NosebleedSession?> EnsureCabinetRunningAsync(ArcadeCabinet cabinet, CancellationToken cancellationToken)
    {
        nosebleedSessions.Cleanup();
        if (!string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId))
        {
            var existing = nosebleedSessions.GetSessions().FirstOrDefault(x => string.Equals(x.SessionId, cabinet.RuntimeSessionId, StringComparison.OrdinalIgnoreCase) && !x.HasExited);
            if (existing is not null)
            {
                cabinet.LastSeenAliveUtc = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(cancellationToken);
                return new NosebleedSession(existing.SessionId, existing.GameId, existing.FileId, existing.Port, existing.BaseUrl, existing.LocalUrl, string.Empty, existing.StartedUtc, existing.CorePath, existing.ContentPath);
            }
        }

        var (file, contentPath, error) = await fileResolver.ResolveAsync(cabinet, cancellationToken);
        if (file is null || string.IsNullOrWhiteSpace(contentPath))
        {
            cabinet.LastError = error ?? "Cabinet ROM could not be resolved.";
            await db.SaveChangesAsync(cancellationToken);
            return null;
        }

        var result = await nosebleedSessions.StartOrReuseAsync(cabinet.GameId, file.Id, cabinet.Game.SystemName, contentPath, cancellationToken, instanceKey: $"arcade-cabinet:{cabinet.Id}");
        if (!result.Success || result.Session is null)
        {
            cabinet.LastError = result.Error ?? "Failed to start cabinet.";
            await db.SaveChangesAsync(cancellationToken);
            return null;
        }

        cabinet.GameFileId = file.Id;
        cabinet.RuntimeSessionId = result.Session.Id;
        cabinet.LastStartedUtc ??= result.Session.StartedUtc;
        cabinet.LastSeenAliveUtc = DateTimeOffset.UtcNow;
        cabinet.LastError = null;
        await db.SaveChangesAsync(cancellationToken);
        return result.Session;
    }

    private const string NosebleedViewerCookieName = "games_vault_nosebleed_viewer";

    private string GetOrCreateNosebleedViewerId()
    {
        if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var existing) && Guid.TryParse(existing, out _)) return existing;
        var id = Guid.NewGuid().ToString("N");
        Response.Cookies.Append(NosebleedViewerCookieName, id, new CookieOptions
        {
            Path = "/",
            MaxAge = TimeSpan.FromDays(30),
            SameSite = SameSiteMode.None,
            Secure = true
        });
        return id;
    }
}
