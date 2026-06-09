using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Globalization;

namespace games_vault.Controllers;

public class RoomController(
    AppDbContext db,
    GamePlayRoomService roomService,
    ProfileShareLinkService shareLinkService,
    CurrentProfileService currentProfile,
    CurrentAccessService currentAccess,
    NosebleedSeatManager nosebleedSeats,
    GameFileStorage fileStorage) : Controller
{
    private const string NosebleedViewerCookieName = "games_vault_nosebleed_viewer";

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateRoom(int id, CancellationToken cancellationToken = default)
    {
        var game = await db.Games
            .AsNoTracking()
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.Id == id, cancellationToken);

        if (game is null)
        {
            return NotFound();
        }

        var file = game.Files.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f.StoragePath) || !string.IsNullOrWhiteSpace(f.ExternalPath));
        if (file is null)
        {
            TempData["Message"] = "No ROM file is available for this game yet.";
            return RedirectToAction("PlayServer", "Session", new { id });
        }

        var contentPath = await ResolveGameFileAbsolutePathAsync(file, cancellationToken);
        if (string.IsNullOrWhiteSpace(contentPath))
        {
            TempData["Message"] = "ROM file could not be resolved to an allowed local filesystem path.";
            return RedirectToAction("PlayServer", "Session", new { id });
        }

        var created = await roomService.CreateRoomAsync(game.Id, file.Id, game.SystemName, contentPath, cancellationToken);
        if (!created.Success || created.Room is null)
        {
            TempData["Message"] = created.Error ?? "Failed to create room.";
            return RedirectToAction("PlayServer", "Session", new { id });
        }

        return RedirectToRoute("PlayServerRoom", new { id, code = created.Room.Code });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateRoomShareLink(int roomId, RoomShareGrantMode grantMode, CancellationToken cancellationToken = default)
    {
        var room = await db.GamePlayRooms
            .AsNoTracking()
            .Include(x => x.Game)
            .FirstOrDefaultAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, cancellationToken);
        if (room is null)
        {
            return NotFound();
        }

        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        var isAdmin = await currentAccess.IsAdminAsync(cancellationToken);
        if (profile is null || (!isAdmin && room.CreatedByProfileId != profile.Id))
        {
            return Forbid();
        }

        var created = await shareLinkService.CreateAsync(room.Id, profile.Id, grantMode, cancellationToken);
        var sessionCode = await shareLinkService.CreateRedeemSessionAsync(created.ShareLink.Id, cancellationToken);
        var shareLink = Url.RouteUrl(
            "PlayServerRoom",
            new { id = room.GameId, code = room.Code, share = sessionCode },
            Request.Scheme) ?? string.Empty;
        var grantModeLabel = grantMode.ToString();

        if (IsAjaxRequest())
        {
            return Json(new { link = shareLink, grantMode = grantModeLabel });
        }

        TempData["GeneratedShareLink"] = shareLink;
        TempData["GeneratedShareGrantMode"] = grantModeLabel;
        return RedirectToRoute("PlayServerRoom", new { id = room.GameId, code = room.Code });
    }

    [HttpGet]
    public async Task<IActionResult> RoomPresence(int roomId, CancellationToken cancellationToken = default)
    {
        var room = await db.GamePlayRooms
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, cancellationToken);
        if (room is null || string.IsNullOrWhiteSpace(room.NosebleedSessionId))
        {
            return NotFound();
        }

        var assignments = nosebleedSeats.GetAssignments(room.NosebleedSessionId, DateTimeOffset.UtcNow);
        var viewerIds = assignments.Select(x => x.ViewerId).Distinct(StringComparer.Ordinal).ToList();
        var participants = viewerIds.Count == 0
            ? []
            : await db.GamePlayRoomParticipants
                .AsNoTracking()
                .Where(x => x.RoomId == room.Id && viewerIds.Contains(x.ViewerId))
                .ToListAsync(cancellationToken);

        var snapshot = GamePlayRoomService.BuildPresenceSnapshot(assignments, participants);
        return Json(new
        {
            players = snapshot.Players.Select(x => new { displayName = x.DisplayName, playerNumber = x.PlayerNumber, port = x.Port, viewerId = x.ViewerId }),
            watchers = snapshot.Watchers.Select(x => new { displayName = x.DisplayName }),
            watcherCount = snapshot.WatcherCount,
            totalConnected = snapshot.TotalConnected
        });
    }

    [HttpGet]
    public async Task<IActionResult> RoomChat(int roomId, CancellationToken cancellationToken = default)
    {
        var roomExists = await db.GamePlayRooms
            .AsNoTracking()
            .AnyAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, cancellationToken);
        if (!roomExists)
        {
            return NotFound();
        }

        var messages = await db.GamePlayRoomChatMessages
            .AsNoTracking()
            .Where(x => x.RoomId == roomId)
            .OrderByDescending(x => x.CreatedUtc)
            .Take(40)
            .ToListAsync(cancellationToken);

        var snapshot = GamePlayRoomService.BuildChatSnapshot(messages);
        return Json(new
        {
            messages = snapshot.Messages.Select(x => new
            {
                displayName = System.Web.HttpUtility.HtmlEncode(x.DisplayName),
                message = System.Web.HttpUtility.HtmlEncode(x.Message),
                createdUtc = x.CreatedUtc.ToString("O", CultureInfo.InvariantCulture)
            })
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> KickRoomPlayer(int roomId, string viewerId, CancellationToken cancellationToken = default)
    {
        if (!Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var requesterViewerId) ||
            !Guid.TryParse(requesterViewerId, out _))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            return Json(new { error = "A player identity is required to kick a player." });
        }

        var result = await roomService.KickRoomPlayerAsync(roomId, requesterViewerId, viewerId, cancellationToken);
        if (!result.Success)
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return Json(new { error = result.Error ?? "Unable to kick player." });
        }

        return Json(new { ok = true });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RoomChat(int roomId, string message, CancellationToken cancellationToken = default)
    {
        var result = await roomService.AddChatMessageAsync(roomId, message, cancellationToken);
        if (!result.Success || result.Message is null)
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            return Json(new { error = result.Error ?? "Unable to send chat message." });
        }

        return Json(new
        {
            ok = true,
            message = new
            {
                displayName = System.Web.HttpUtility.HtmlEncode(
                    string.IsNullOrWhiteSpace(result.Message.DisplayNameSnapshot) ? "Player" : result.Message.DisplayNameSnapshot.Trim()),
                message = System.Web.HttpUtility.HtmlEncode(result.Message.Message ?? ""),
                createdUtc = DateTime.SpecifyKind(result.Message.CreatedUtc, DateTimeKind.Utc).ToString("O", CultureInfo.InvariantCulture)
            }
        });
    }

    private bool IsAjaxRequest()
    {
        return string.Equals(Request.Headers["X-Requested-With"], "XMLHttpRequest", StringComparison.OrdinalIgnoreCase)
            || Request.Headers.Accept.Any(x => x?.Contains("application/json", StringComparison.OrdinalIgnoreCase) == true);
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
}
