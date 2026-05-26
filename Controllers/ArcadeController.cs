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
    NosebleedTicketSigner nosebleedTickets,
    GamePlayTelemetryService gamePlayTelemetry,
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
            }
        }

        var gameOptions = canManage
            ? await db.Games
                .AsNoTracking()
                .Where(g => g.Files.Any(f => f.StoragePath != null || f.ExternalPath != null))
                .OrderBy(g => g.Name)
                .Take(300)
                .Select(g => new ArcadeGameOptionViewModel { Id = g.Id, Name = g.Name, SystemName = g.SystemName })
                .ToListAsync(cancellationToken)
            : new List<ArcadeGameOptionViewModel>();

        return View(new ArcadeIndexViewModel
        {
            Arcade = arcade,
            Cabinets = cabinets,
            GameOptions = gameOptions,
            CanManage = canManage,
            CanPlay = canPlay,
            NosebleedEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled
        });
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
                Error = cabinet.LastError ?? "Cabinet is not running yet."
            });
        }

        var viewerId = GetOrCreateNosebleedViewerId();
        var canPlay = await currentAccess.CanPlayAsync(cancellationToken);
        var seat = canPlay ? nosebleedSeats.Assign(session.Id, viewerId, DateTimeOffset.UtcNow) : null;
        var token = canPlay && seat?.Kind == NosebleedSeatKind.Player && seat.Port is not null
            ? nosebleedTickets.CreatePlayerToken(session.Id, viewerId, seat.Port.Value)
            : nosebleedTickets.CreateSpectatorToken(session.Id, viewerId);

        if (canPlay)
        {
            var profile = await currentProfile.GetCurrentAsync(cancellationToken);
            await gamePlayTelemetry.StartAsync(cabinet.GameId, cabinet.GameFileId, "arcade-free-play", session.Id, profile?.Id, cancellationToken);
        }

        return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
        {
            Game = cabinet.Game,
            File = cabinet.GameFile,
            PlayerEnabled = (nosebleedOptions.Value ?? new NosebleedOptions()).Enabled,
            BaseUrl = session.BaseUrl,
            Token = token,
            SessionId = session.Id,
            AssignedPort = seat?.Port,
            PlayerNumber = seat?.PlayerNumber,
            IsSpectator = !canPlay || seat?.Kind == NosebleedSeatKind.Spectator,
            SeatExpiresUtc = seat?.ExpiresUtc,
            CorePath = session.CorePath,
            ContentPath = session.ContentPath,
            LeaveSessionReturnUrl = Url.Action(nameof(Index), "Arcade")
        });
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
                return new NosebleedSession(existing.SessionId, existing.GameId, existing.FileId, existing.Port, existing.BaseUrl, string.Empty, existing.StartedUtc, existing.CorePath, existing.ContentPath);
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
        cabinet.GameFile = file;
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
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = Request.IsHttps,
            MaxAge = TimeSpan.FromDays(30)
        });
        return id;
    }
}
