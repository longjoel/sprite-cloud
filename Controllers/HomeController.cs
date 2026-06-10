using System.Diagnostics;
using System.Net.WebSockets;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using games_vault.Models;
using games_vault.Profiles;

namespace games_vault.Controllers;

public class HomeController(
    AppDbContext db,
    GamePlayTelemetryService gamePlayTelemetry,
    NosebleedSessionManager nosebleedSessions,
    NosebleedTicketSigner nosebleedTickets,
    NosebleedRelayMetrics nosebleedRelayMetrics,
    NosebleedProcessInspector nosebleedProcessInspector,
    LibretroDatabaseSyncService libretroSync,
    CurrentProfileService currentProfile,
    CurrentAccessService currentAccess) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        var gamesCount = await db.Games.AsNoTracking().CountAsync(cancellationToken);
        var systemsCount = await db.Games.AsNoTracking().Select(x => x.SystemName).Distinct().CountAsync(cancellationToken);

        var activeSessions = nosebleedSessions.GetSessions();
        await gamePlayTelemetry.ReconcileActiveExternalSessionsAsync(
            "nosebleed",
            activeSessions.Select(x => x.SessionId).ToHashSet(StringComparer.OrdinalIgnoreCase),
            "process-exit",
            cancellationToken);

        var currentUserProfile = await currentProfile.GetCurrentAsync(cancellationToken);
        var accessMode = await currentAccess.GetAccessModeAsync(cancellationToken);
        var canPlay = accessMode is AccessMode.Player or AccessMode.Admin;
        var canManageLibrary = accessMode is AccessMode.Admin;
        var telemetryStats = await gamePlayTelemetry.GetDashboardStatsAsync(currentUserProfile?.Id, cancellationToken);
        var globalTelemetryStats = currentUserProfile is null
            ? telemetryStats
            : await gamePlayTelemetry.GetDashboardStatsAsync(null, cancellationToken);
        var lastPlayedGameQuery = db.GamePlaySessions
            .AsNoTracking();
        if (currentUserProfile is not null)
        {
            lastPlayedGameQuery = lastPlayedGameQuery.Where(x => x.ProfileId == currentUserProfile.Id);
        }
        var lastPlayedGame = await lastPlayedGameQuery
            .OrderByDescending(x => x.StartedUtc)
            .Select(x => x.Game.Name)
            .FirstOrDefaultAsync(cancellationToken);
        var playRowsQuery = db.GamePlaySessions
            .AsNoTracking()
            .Where(x => x.StartedUtc >= DateTime.UtcNow.AddDays(-90));
        if (currentUserProfile is not null)
        {
            playRowsQuery = playRowsQuery.Where(x => x.ProfileId == currentUserProfile.Id);
        }
        var playRows = await playRowsQuery
            .Select(x => new
            {
                x.GameId,
                GameName = x.Game.Name,
                x.StartedUtc,
                x.EndedUtc,
                x.DurationSeconds,
                x.Mode,
                x.EndReason,
                x.ProfileId,
                ProfileName = x.Profile != null ? x.Profile.DisplayName : null
            })
            .ToListAsync(cancellationToken);

        var now = DateTime.UtcNow;
        var activeProfileSessionById = playRows
            .Where(x => x.EndedUtc is null && x.ProfileId.HasValue)
            .GroupBy(x => x.ProfileId!.Value)
            .ToDictionary(
                g => g.Key,
                g => g.OrderByDescending(x => x.StartedUtc).First());

        var activeProfileRows = await db.ProfileAuthSessions
            .AsNoTracking()
            .Where(x => x.RevokedUtc == null && !x.Profile.IsArchived)
            .OrderByDescending(x => x.LastSeenUtc)
            .Select(x => new
            {
                x.ProfileId,
                x.LastSeenUtc,
                x.Profile.DisplayName,
                x.Profile.Username,
                x.Profile.Color,
                x.Profile.IsAdmin
            })
            .Take(8)
            .ToListAsync(cancellationToken);

        var activeProfiles = activeProfileRows
            .Select(x =>
            {
                activeProfileSessionById.TryGetValue(x.ProfileId, out var activeSession);
                return new ActiveProfileSummaryViewModel
                {
                    ProfileId = x.ProfileId,
                    DisplayName = x.DisplayName,
                    Username = x.Username,
                    Color = x.Color,
                    IsAdmin = x.IsAdmin,
                    IsCurrent = currentUserProfile?.Id == x.ProfileId,
                    LastSeenUtc = x.LastSeenUtc,
                    CurrentGameName = activeSession?.GameName,
                    CurrentMode = activeSession?.Mode,
                    CurrentSessionStartedUtc = activeSession?.StartedUtc
                };
            })
            .ToList();

        var recentSessions = playRows
            .OrderByDescending(x => x.StartedUtc)
            .Take(8)
            .Select(x => new HomeRecentSessionViewModel
            {
                GameId = x.GameId,
                GameName = x.GameName,
                Mode = x.Mode,
                StartedUtc = x.StartedUtc,
                EndedUtc = x.EndedUtc,
                Duration = TimeSpan.FromSeconds(Math.Max(0, x.EndedUtc.HasValue
                    ? x.DurationSeconds
                    : (int)Math.Round((now - x.StartedUtc).TotalSeconds, MidpointRounding.AwayFromZero))),
                EndReason = x.EndReason,
                ProfileId = x.ProfileId,
                ProfileName = x.ProfileName
            })
            .ToList();

        var topPlayedGames = playRows
            .GroupBy(x => new { x.GameId, x.GameName })
            .Select(g => new TopPlayedGameViewModel
            {
                GameId = g.Key.GameId,
                GameName = g.Key.GameName,
                SessionCount = g.Count(),
                TotalPlayTime = TimeSpan.FromSeconds(g.Sum(x => Math.Max(0, x.EndedUtc.HasValue
                    ? x.DurationSeconds
                    : (int)Math.Round((now - x.StartedUtc).TotalSeconds, MidpointRounding.AwayFromZero))))
            })
            .OrderByDescending(x => x.TotalPlayTime)
            .ThenByDescending(x => x.SessionCount)
            .ThenBy(x => x.GameName)
            .Take(5)
            .ToList();

        var activeGameIds = activeSessions.Select(x => x.GameId).Distinct().ToArray();
        var activeGameNames = activeGameIds.Length == 0
            ? new Dictionary<int, string>()
            : await db.Games
                .AsNoTracking()
                .Where(x => activeGameIds.Contains(x.Id))
                .Select(x => new { x.Id, x.Name })
                .ToDictionaryAsync(x => x.Id, x => x.Name, cancellationToken);
        var libraryPreviewGames = await db.Games
            .AsNoTracking()
            .OrderByDescending(x => x.CreatedUtc)
            .ThenBy(x => x.Name)
            .Take(8)
            .Select(x => new HomeLibraryPreviewGameViewModel
            {
                GameId = x.Id,
                GameName = x.Name,
                SystemName = x.SystemName,
                Genre = x.Genre,
                NumberOfPlayers = x.NumberOfPlayers,
                IsRunningNow = activeGameIds.Contains(x.Id)
            })
            .ToListAsync(cancellationToken);
        var arcadeSessionMap = await db.ArcadeCabinets
            .AsNoTracking()
            .Where(x => x.RuntimeSessionId != null)
            .Select(x => new { x.Id, x.DisplayName, x.RuntimeSessionId })
            .ToDictionaryAsync(x => x.RuntimeSessionId!, x => new { x.Id, x.DisplayName }, StringComparer.OrdinalIgnoreCase, cancellationToken);
        var roomCodeMap = await db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.Status == GamePlayRoomStatus.Active && x.NosebleedSessionId != null)
            .Select(x => new { x.NosebleedSessionId, x.Code })
            .ToDictionaryAsync(x => x.NosebleedSessionId!, x => x.Code, StringComparer.OrdinalIgnoreCase, cancellationToken);
        var activeSessionModels = activeSessions
            .Select(x =>
            {
                var isArcadeCabinet = arcadeSessionMap.TryGetValue(x.SessionId, out var arcadeCabinet);
                return new ActiveNosebleedSessionViewModel
                {
                    SessionId = x.SessionId,
                    GameId = x.GameId,
                    FileId = x.FileId,
                    GameName = activeGameNames.TryGetValue(x.GameId, out var name) ? name : $"Game #{x.GameId}",
                    Port = x.Port,
                    BaseUrl = x.BaseUrl,
                    StartedUtc = x.StartedUtc,
                    Runtime = x.Runtime,
                    CorePath = x.CorePath,
                    ContentPath = x.ContentPath,
                    ProcessId = x.ProcessId,
                    HasExited = x.HasExited,
                    IsArcadeCabinet = isArcadeCabinet,
                    ArcadeCabinetId = isArcadeCabinet ? arcadeCabinet!.Id : null,
                    ArcadeCabinetName = isArcadeCabinet ? arcadeCabinet!.DisplayName : null,
                    RoomCode = roomCodeMap.TryGetValue(x.SessionId, out var roomCode) ? roomCode : null
                };
            })
            .ToList();
        var activeArcadeCabinets = activeSessionModels
            .Where(x => x.IsArcadeCabinet)
            .OrderBy(x => x.ArcadeCabinetName ?? x.GameName)
            .ToList();
        var activeLibrarySessions = activeSessionModels
            .Where(x => !x.IsArcadeCabinet)
            .OrderByDescending(x => x.StartedUtc)
            .ToList();
        var featuredSession = activeArcadeCabinets.FirstOrDefault()
            ?? activeLibrarySessions.FirstOrDefault()
            ?? activeSessionModels.FirstOrDefault();

        return View(new HomeIndexViewModel
        {
            ShowDashboard = telemetryStats.TotalSessions > 0 || activeSessionModels.Count > 0 || gamesCount > 0,
            CurrentProfileId = currentUserProfile?.Id,
            CurrentProfileName = currentUserProfile?.DisplayName,
            AccessMode = accessMode.ToString(),
            CanPlay = canPlay,
            CanManageLibrary = canManageLibrary,
            GlobalTotalPlayTime = TimeSpan.FromSeconds(globalTelemetryStats.TotalDurationSeconds),
            GlobalPlaySessionCount = globalTelemetryStats.TotalSessions,
            GamesCount = gamesCount,
            SystemsCount = systemsCount,
            TotalPlayTime = TimeSpan.FromSeconds(telemetryStats.TotalDurationSeconds),
            PlaySessionCount = telemetryStats.TotalSessions,
            LastPlayedGame = lastPlayedGame,
            FeaturedSession = featuredSession,
            LibraryPreviewGames = libraryPreviewGames,
            TopPlayedGames = topPlayedGames,
            ActiveNosebleedSessions = activeSessionModels,
            ActiveArcadeCabinets = activeArcadeCabinets,
            ActiveLibrarySessions = activeLibrarySessions,
            ActiveProfiles = activeProfiles,
            RecentSessions = recentSessions,
        });
    }

    [HttpGet]
    public async Task<IActionResult> NosebleedPreviewVideo(string sessionId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return BadRequest("No Nosebleed session id was provided.");
        }

        var session = nosebleedSessions.GetSessions()
            .FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase));
        if (session is null || session.HasExited)
        {
            return NotFound();
        }

        var token = nosebleedTickets.CreateSpectatorToken(session.SessionId, "games-vault-dashboard");
        var target = BuildNosebleedSnapshotUri(session.BaseUrl, token);
        if (target is null)
        {
            return StatusCode(StatusCodes.Status502BadGateway);
        }

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            using var upstreamResponse = await http.GetAsync(target, cancellationToken);
            if (!upstreamResponse.IsSuccessStatusCode)
            {
                return StatusCode((int)upstreamResponse.StatusCode);
            }

            var contentType = upstreamResponse.Content.Headers.ContentType?.ToString() ?? "image/png";
            var bytes = await upstreamResponse.Content.ReadAsByteArrayAsync(cancellationToken);
            return File(bytes, contentType);
        }
        catch (TaskCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499); // Client Closed Request
        }
        catch
        {
            return StatusCode(StatusCodes.Status502BadGateway);
        }
    }

    [HttpGet]
    public async Task NosebleedPreviewStream(string sessionId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || !HttpContext.WebSockets.IsWebSocketRequest)
        {
            HttpContext.Response.StatusCode = 400;
            return;
        }

        var session = nosebleedSessions.GetSessions()
            .FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase));
        if (session is null || session.HasExited)
        {
            HttpContext.Response.StatusCode = 404;
            return;
        }

        var token = nosebleedTickets.CreateSpectatorToken(session.SessionId, "games-vault-dashboard");
        var target = BuildNosebleedWebSocketUri(session.BaseUrl, "/ws/video", token);
        if (target is null)
        {
            HttpContext.Response.StatusCode = 502;
            return;
        }

        using var upstream = new ClientWebSocket();
        try
        {
            await upstream.ConnectAsync(target, cancellationToken);
        }
        catch
        {
            HttpContext.Response.StatusCode = 502;
            return;
        }

        using var downstream = await HttpContext.WebSockets.AcceptWebSocketAsync();
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linkedCts.CancelAfter(TimeSpan.FromSeconds(30));

        try
        {
            await NosebleedWebSocketRelay.PumpLatestOnlyAsync(
                upstream, downstream, "video", metrics: null, linkedCts.Token);
        }
        catch (OperationCanceledException) when (linkedCts.IsCancellationRequested) { }
        catch (WebSocketException) { }
        finally
        {
            if (downstream.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try { await downstream.CloseAsync(WebSocketCloseStatus.NormalClosure, "preview-end", CancellationToken.None); }
                catch { }
            }
        }
    }

    private static Uri? BuildNosebleedSnapshotUri(string baseUrl, string? token)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri))
        {
            return null;
        }

        var builder = new UriBuilder(new Uri(baseUri, "/session/snapshot"));
        if (!string.IsNullOrWhiteSpace(token))
        {
            builder.Query = $"token={Uri.EscapeDataString(token)}";
        }

        return builder.Uri;
    }

    private static Uri? BuildNosebleedWebSocketUri(string baseUrl, string path, string? token)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri))
        {
            return null;
        }

        var builder = new UriBuilder(new Uri(baseUri, path))
        {
            Scheme = baseUri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws"
        };
        if (!string.IsNullOrWhiteSpace(token))
        {
            builder.Query = $"token={Uri.EscapeDataString(token)}";
        }

        return builder.Uri;
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StopNosebleedSession(string sessionId, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            TempData["Message"] = "Admin mode is required to stop Nosebleed sessions.";
            return RedirectToAction("Index", "Admin", fragment: "admin-nosebleed-runtime");
        }

        if (string.IsNullOrWhiteSpace(sessionId))
        {
            TempData["Message"] = "No Nosebleed session id was provided.";
            return RedirectToAction("Index", "Admin", fragment: "admin-nosebleed-runtime");
        }

        var stopped = nosebleedSessions.TryStop(sessionId, "manual-stop");
        await gamePlayTelemetry.FinishByExternalSessionAsync(sessionId, "manual-stop", cancellationToken);
        TempData["Message"] = stopped
            ? $"Stopped Nosebleed session {sessionId}."
            : $"Nosebleed session {sessionId} was not found.";
        return RedirectToAction("Index", "Admin", fragment: "admin-nosebleed-runtime");
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> KillNosebleedProcess(int pid, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            TempData["Message"] = "Admin mode is required to kill Nosebleed processes.";
            return RedirectToAction("Index", "Admin", fragment: "admin-nosebleed-runtime");
        }

        if (nosebleedSessions.GetManagedProcessIds().Contains(pid))
        {
            TempData["Message"] = $"Process {pid} is a managed Nosebleed session. Use Stop session instead.";
            return RedirectToAction("Index", "Admin", fragment: "admin-nosebleed-runtime");
        }

        var killed = nosebleedProcessInspector.TryKillIfNosebleed(pid);
        TempData["Message"] = killed
            ? $"Killed orphan Nosebleed process {pid}."
            : $"Process {pid} was not a live Nosebleed process or could not be killed.";
        return RedirectToAction("Index", "Admin", fragment: "admin-nosebleed-runtime");
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartLibretroSync(bool force = false, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            TempData["Message"] = "Admin profile required.";
            return RedirectToAction("Index", "Profiles");
        }

        await libretroSync.SyncAsync(force, cancellationToken);
        TempData["Message"] = force ? "Forced libretro database re-sync complete." : "Libretro database sync complete.";
        return RedirectToAction("Index", "Admin");
    }

    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
    }
}
