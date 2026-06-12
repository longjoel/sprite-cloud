using System.Net.WebSockets;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using System.Globalization;
using System.Text.Json;

namespace games_vault.Controllers;

public class SessionController : Controller
{
    private readonly AppDbContext _db;

    public SessionController(AppDbContext db)
    {
        _db = db;
    }

    private T Resolve<T>() where T : notnull => HttpContext.RequestServices.GetRequiredService<T>();

    private const string NosebleedViewerCookieName = "games_vault_nosebleed_viewer";

    private bool IsAjaxRequest()
    {
        return string.Equals(Request.Headers["X-Requested-With"], "XMLHttpRequest", StringComparison.OrdinalIgnoreCase)
            || Request.Headers.Accept.Any(x => x?.Contains("application/json", StringComparison.OrdinalIgnoreCase) == true);
    }

    [HttpGet("/Games/PlayServer/{id:int}/{code?}", Name = "PlayServerRoom")]
    public async Task<IActionResult> PlayServer(int id, string? code = null, string? share = null, CancellationToken cancellationToken = default)
    {
        var hasRouteCode = RouteData.Values.TryGetValue("code", out var routeCodeValue)
            && routeCodeValue is string routeCode
            && !string.IsNullOrWhiteSpace(routeCode);
        if (!string.IsNullOrWhiteSpace(code) && !hasRouteCode && string.IsNullOrWhiteSpace(share))
        {
            return RedirectToRoute("PlayServerRoom", new { id, code });
        }

        var game = await _db.Games
            .AsNoTracking()
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.Id == id, cancellationToken);

        if (game is null)
        {
            return NotFound();
        }

        var nosebleedOptions = Resolve<IOptions<NosebleedOptions>>();
        var currentProfile = Resolve<CurrentProfileService>();
        var currentAccess = Resolve<CurrentAccessService>();
        var shareLinkService = Resolve<ProfileShareLinkService>();
        var roomService = Resolve<GamePlayRoomService>();
        var gamePlayTelemetry = Resolve<GamePlayTelemetryService>();
        var fileStorage = Resolve<GameFileStorage>();

        var opts = nosebleedOptions.Value ?? new NosebleedOptions();
        var file = game.Files.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f.StoragePath) || !string.IsNullOrWhiteSpace(f.ExternalPath));
        var currentSignedInProfile = await currentProfile.GetCurrentAsync(cancellationToken);
        var canChat = await currentAccess.CanChatAsync(cancellationToken);

        string? error = null;
        NosebleedSession? session = null;
        NosebleedSeatAssignment? seat = null;
        string? token = null;
        string? contentPath = null;
        int? currentRoomId = null;

        if (!opts.Enabled)
        {
            error = "Server-side playback is disabled. Enable it in appsettings under 'Nosebleed:Enabled'.";
        }
        else if (file is null)
        {
            error = "No stored or linked ROM file found for this game.";
        }
        else if (!string.IsNullOrWhiteSpace(share))
        {
            try
            {
                var viewerId = GetOrCreateNosebleedViewerId();
                var redeemed = await shareLinkService.RedeemBySessionCodeAsync(share, cancellationToken);
                if (redeemed.ShareLink?.Room is not null)
                {
                    var joinResult = await roomService.JoinByShareTokenAsync(redeemed.ShareLink, redeemed.Profile, viewerId, cancellationToken);
                    if (joinResult.Success && joinResult.Room is not null && joinResult.Session is not null)
                    {
                        currentSignedInProfile = await currentProfile.GetCurrentAsync(cancellationToken);
                        currentRoomId = joinResult.Room.Id;
                        session = joinResult.Session;
                        seat = joinResult.Seat;
                        token = joinResult.Token;
                        await gamePlayTelemetry.StartAsync(joinResult.Room.GameId, joinResult.Room.GameFileId, "nosebleed-share", session.Id, currentSignedInProfile?.Id, cancellationToken);
                    }
                    else
                    {
                        TempData["Message"] = joinResult.Error ?? "Unable to join the requested room.";
                        return RedirectToAction(nameof(Index), "Games");
                    }
                }
                else
                {
                    TempData["Message"] = "Unable to redeem the requested share link.";
                    return RedirectToAction(nameof(Index), "Games");
                }
            }
            catch (InvalidOperationException ex)
            {
                TempData["Message"] = ex.Message;
                return RedirectToAction(nameof(Index), "Games");
            }
        }
        else if (!string.IsNullOrWhiteSpace(code))
        {
            var viewerId = GetOrCreateNosebleedViewerId();
            var joinResult = await roomService.JoinByCodeAsync(code, viewerId, cancellationToken);
            if (joinResult.Success && joinResult.Room is not null && joinResult.Session is not null)
            {
                currentRoomId = joinResult.Room.Id;
                session = joinResult.Session;
                seat = joinResult.Seat;
                token = joinResult.Token;
                await gamePlayTelemetry.StartAsync(game.Id, file.Id, "nosebleed", session.Id, currentSignedInProfile?.Id, cancellationToken);
            }
            else
            {
                TempData["Message"] = joinResult.Error ?? "Unable to join the requested room.";
                return RedirectToAction(nameof(Index), "Games");
            }
        }
        else
        {
            if (await currentAccess.CanPlayAsync(cancellationToken) && file is not null)
            {
                contentPath = await ResolveGameFileAbsolutePathAsync(file, cancellationToken);
                if (string.IsNullOrWhiteSpace(contentPath))
                {
                    error = "ROM file could not be resolved to an allowed local filesystem path.";
                }
                else
                {
                    var created = await roomService.CreateRoomAsync(game.Id, file.Id, game.SystemName, contentPath, cancellationToken);
                    if (created.Success && created.Room is not null)
                    {
                        if (created.Diagnostics.Count > 0)
                        {
                            TempData["BatterySaveDiagnostics"] = JsonSerializer.Serialize(created.Diagnostics, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                        }

                        return RedirectToRoute("PlayServerRoom", new { id, code = created.Room.Code });
                    }

                    error = created.Error ?? "Failed to create a room for this game.";
                }
            }
            else
            {
                error = "Create a new session from this game page to start server-side play.";
            }
        }

        var canCreateShareLinks = false;
        if (currentRoomId is int roomId && currentSignedInProfile is not null)
        {
            var roomOwnerId = await _db.GamePlayRooms
                .AsNoTracking()
                .Where(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active)
                .Select(x => x.CreatedByProfileId)
                .FirstOrDefaultAsync(cancellationToken);
            canCreateShareLinks = currentSignedInProfile.IsAdmin || roomOwnerId == currentSignedInProfile.Id;
        }

        var batterySaveDiagnostics = ReadBatterySaveDiagnosticsFromTempData();
        var turnService = Resolve<ITurnCredentialService>();
        var turnCredentials = turnService.GenerateCredentials(ttlSeconds: 3600);

        return View("~/Views/Games/PlayServer.cshtml", new ServerGamePlayViewModel
        {
            Game = game,
            File = file,
            PlayerEnabled = opts.Enabled,
            BaseUrl = session?.BaseUrl,
            SessionId = session?.Id,
            ViewerId = GetOrCreateNosebleedViewerId(),
            AssignedPort = seat?.Port,
            PlayerNumber = seat?.PlayerNumber,
            IsSpectator = seat?.Kind == NosebleedSeatKind.Spectator,
            SeatExpiresUtc = seat?.ExpiresUtc,
            Error = error,
            CurrentRoomId = currentRoomId,
            IsArcadeRoom = false,
            CanChat = canChat,
            CurrentProfileDisplayName = currentSignedInProfile?.DisplayName,
            CurrentProfileIsEphemeralGuest = currentSignedInProfile?.IsEphemeral == true && currentSignedInProfile.ParentProfileId is not null,
            CurrentProfileParentDisplayName = currentSignedInProfile?.ParentProfile?.DisplayName,
            BatterySaveDiagnostics = batterySaveDiagnostics,
            TurnUrls = turnCredentials?.Urls,
            TurnUsername = turnCredentials?.Username,
            TurnCredential = turnCredentials?.Credential,
            CanCreateShareLinks = canCreateShareLinks,
            GeneratedShareLink = TempData["GeneratedShareLink"] as string,
            GeneratedShareGrantMode = TempData["GeneratedShareGrantMode"] as string
        });
    }

    private IReadOnlyList<ProfileBatterySaveLogEntry> ReadBatterySaveDiagnosticsFromTempData()
    {
        if (TempData.Peek("BatterySaveDiagnostics") is not string rawDiagnostics || string.IsNullOrWhiteSpace(rawDiagnostics))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<ProfileBatterySaveLogEntry>>(rawDiagnostics, new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? [];
        }
        catch (JsonException)
        {
            return [new ProfileBatterySaveLogEntry("warn", "Battery saves", "Saved battery diagnostics could not be loaded.")];
        }
    }

    [HttpPost("/Games/KeepAliveServerSession")]
    public async Task<IActionResult> KeepAliveServerSession(string sessionId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return BadRequest();
        }

        var viewerId = ResolveViewerIdFromRequest();
        if (viewerId is null)
        {
            return BadRequest();
        }

        var nosebleedSessions = Resolve<NosebleedSessionManager>();
        var gamePlayTelemetry = Resolve<GamePlayTelemetryService>();
        var currentAccess = Resolve<CurrentAccessService>();
        var nosebleedSeats = Resolve<NosebleedSeatManager>();
        var roomService = Resolve<GamePlayRoomService>();

        nosebleedSessions.Cleanup();
        if (!nosebleedSessions.GetSessions().Any(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase)))
        {
            await gamePlayTelemetry.FinishByExternalSessionAsync(sessionId, "process-exit", cancellationToken);
            return NotFound();
        }

        var canPlay = await currentAccess.CanPlaySessionAsync(sessionId, cancellationToken);
        var seat = nosebleedSeats.Assign(sessionId, viewerId, DateTimeOffset.UtcNow, allowPlayer: canPlay);
        var roomId = await _db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.NosebleedSessionId == sessionId && x.Status == GamePlayRoomStatus.Active)
            .Select(x => (int?)x.Id)
            .FirstOrDefaultAsync(cancellationToken);
        if (roomId is int id)
        {
            await roomService.TouchRoomParticipantSessionAsync(id, viewerId, seat, cancellationToken);
        }

        await gamePlayTelemetry.TouchDurationAsync(sessionId, cancellationToken);
        return Json(new
        {
            kind = seat.Kind.ToString().ToLowerInvariant(),
            port = seat.Port,
            playerNumber = seat.PlayerNumber,
            expiresUtc = seat.ExpiresUtc
        });
    }

    [HttpGet("/Games/NosebleedProxy")]
    public async Task<IActionResult> NosebleedProxy(string sessionId, string channel, string? videoMode = null, int? jpegQuality = null, CancellationToken cancellationToken = default)
    {
        if (!HttpContext.WebSockets.IsWebSocketRequest)
        {
            return BadRequest("This endpoint requires a WebSocket request.");
        }

        if (!IsAllowedWebSocketOrigin(Request))
        {
            return StatusCode(StatusCodes.Status403Forbidden);
        }

        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(channel))
        {
            return BadRequest();
        }

        var viewerId = ResolveViewerIdFromRequest();
        if (viewerId is null)
        {
            return BadRequest();
        }

        channel = channel.Trim().ToLowerInvariant();
        if (channel is not ("video" or "audio" or "input"))
        {
            return NotFound();
        }

        var nosebleedSessions = Resolve<NosebleedSessionManager>();
        var gamePlayTelemetry = Resolve<GamePlayTelemetryService>();
        var currentAccess = Resolve<CurrentAccessService>();
        var nosebleedSeats = Resolve<NosebleedSeatManager>();
        var roomService = Resolve<GamePlayRoomService>();
        var nosebleedTickets = Resolve<NosebleedTicketSigner>();

        var session = nosebleedSessions.GetSessions()
            .FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase));
        if (session is null || session.HasExited)
        {
            await gamePlayTelemetry.FinishByExternalSessionAsync(sessionId, "process-exit", cancellationToken);
            return NotFound();
        }

        var canPlay = await currentAccess.CanPlaySessionAsync(sessionId, cancellationToken);
        var seat = nosebleedSeats.Assign(sessionId, viewerId, DateTimeOffset.UtcNow, allowPlayer: canPlay);
        string? token;

        // Touch/create participant DB record for cleanup and presence tracking.
        var roomId = await _db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.NosebleedSessionId == sessionId && x.Status == GamePlayRoomStatus.Active)
            .Select(x => (int?)x.Id)
            .FirstOrDefaultAsync(cancellationToken);
        if (roomId is int rid)
        {
            await roomService.TouchRoomParticipantSessionAsync(rid, viewerId, seat, cancellationToken);
        }

        if (channel == "input")
        {
            // Verify the viewer belongs to an active room for this session.
            var isMember = await _db.GamePlayRooms
                .AsNoTracking()
                .Where(r => r.NosebleedSessionId == sessionId && r.Status == GamePlayRoomStatus.Active)
                .Join(_db.GamePlayRoomParticipants.AsNoTracking(),
                    r => r.Id,
                    p => p.RoomId,
                    (r, p) => p.ViewerId)
                .AnyAsync(v => v == viewerId, cancellationToken);

            if (!isMember)
            {
                return Forbid();
            }

            if (!canPlay ||
                seat.Kind != NosebleedSeatKind.Player ||
                seat.Port is null)
            {
                return Forbid();
            }

            token = nosebleedTickets.CreatePlayerToken(sessionId, viewerId, seat.Port.Value);
        }
        else
        {
            token = nosebleedTickets.CreateSpectatorToken(sessionId, viewerId);
        }

        var path = channel == "video"
            ? BuildNosebleedVideoProxyPath(videoMode, jpegQuality)
            : $"/ws/{channel}";
        var target = BuildNosebleedWebSocketUri(session.LocalUrl, path, token);
        if (target is null)
        {
            var logger = Resolve<ILogger<SessionController>>();
            logger.LogWarning("NosebleedProxy target is null: {LocalUrl} {Path}", session.LocalUrl, path);
            return StatusCode(StatusCodes.Status502BadGateway);
        }

        using var upstream = new ClientWebSocket();
        try
        {
            await upstream.ConnectAsync(target, cancellationToken);
        }
        catch (Exception ex)
        {
            var logger = Resolve<ILogger<SessionController>>();
            logger.LogWarning(ex, "NosebleedProxy upstream connect failed: {Target}", target);
            return StatusCode(StatusCodes.Status502BadGateway);
        }

        using var downstream = await HttpContext.WebSockets.AcceptWebSocketAsync();
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, HttpContext.RequestAborted);
        var clientToUpstream = NosebleedWebSocketRelay.PumpOrderedAsync(downstream, upstream, "input", metrics: null, linkedCts.Token);
        var upstreamToClient = NosebleedWebSocketRelay.PumpOrderedAsync(upstream, downstream, "output", metrics: null, linkedCts.Token);
        await Task.WhenAny(clientToUpstream, upstreamToClient);
        await linkedCts.CancelAsync();

        try
        {
            await Task.WhenAll(clientToUpstream, upstreamToClient);
        }
        catch (OperationCanceledException) when (linkedCts.IsCancellationRequested)
        {
        }
        catch (WebSocketException)
        {
        }

        return new EmptyResult();
    }

    [HttpPost("/Games/NosebleedWebRtcSession")]
    public async Task<IActionResult> NosebleedWebRtcSession(string sessionId, CancellationToken cancellationToken = default)
    {
        if (!IsAllowedWebSocketOrigin(Request))
        {
            return StatusCode(StatusCodes.Status403Forbidden);
        }

        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return BadRequest();
        }

        var viewerId = ResolveViewerIdFromRequest();
        if (viewerId is null)
        {
            return BadRequest();
        }

        var nosebleedSessions = Resolve<NosebleedSessionManager>();
        var gamePlayTelemetry = Resolve<GamePlayTelemetryService>();
        var currentAccess = Resolve<CurrentAccessService>();
        var nosebleedSeats = Resolve<NosebleedSeatManager>();
        var roomService = Resolve<GamePlayRoomService>();
        var nosebleedTickets = Resolve<NosebleedTicketSigner>();
        var httpClientFactory = Resolve<IHttpClientFactory>();

        var session = nosebleedSessions.GetSessions()
            .FirstOrDefault(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase));
        if (session is null || session.HasExited)
        {
            await gamePlayTelemetry.FinishByExternalSessionAsync(sessionId, "process-exit", cancellationToken);
            return NotFound();
        }

        var canPlay = await currentAccess.CanPlaySessionAsync(sessionId, cancellationToken);
        var seat = nosebleedSeats.Assign(sessionId, viewerId, DateTimeOffset.UtcNow, allowPlayer: canPlay);
        string? token;

        // Touch/create participant DB record for cleanup and presence tracking.
        var roomId = await _db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.NosebleedSessionId == sessionId && x.Status == GamePlayRoomStatus.Active)
            .Select(x => (int?)x.Id)
            .FirstOrDefaultAsync(cancellationToken);
        if (roomId is int rid)
        {
            await roomService.TouchRoomParticipantSessionAsync(rid, viewerId, seat, cancellationToken);
        }

        if (canPlay && seat.Kind == NosebleedSeatKind.Player && seat.Port is not null)
        {
            token = nosebleedTickets.CreatePlayerToken(sessionId, viewerId, seat.Port.Value);
        }
        else
        {
            token = nosebleedTickets.CreateSpectatorToken(sessionId, viewerId);
        }

        if (string.IsNullOrWhiteSpace(token) || !Uri.TryCreate(session.LocalUrl, UriKind.Absolute, out var baseUri))
        {
            return StatusCode(StatusCodes.Status502BadGateway);
        }

        var target = new UriBuilder(new Uri(baseUri, "/webrtc/session"))
        {
            Query = $"token={Uri.EscapeDataString(token)}"
        };

        var offerJson = await new StreamReader(Request.Body).ReadToEndAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(offerJson))
        {
            return BadRequest("Missing WebRTC offer payload.");
        }

        using var req = new HttpRequestMessage(HttpMethod.Post, target.Uri)
        {
            Content = new StringContent(offerJson, System.Text.Encoding.UTF8, "application/json")
        };

        using var client = httpClientFactory.CreateClient();
        HttpResponseMessage upstream;
        try
        {
            upstream = await client.SendAsync(req, cancellationToken);
        }
        catch
        {
            return StatusCode(StatusCodes.Status502BadGateway);
        }

        await using var upstreamStream = await upstream.Content.ReadAsStreamAsync(cancellationToken);
        using var sr = new StreamReader(upstreamStream);
        var answerBody = await sr.ReadToEndAsync(cancellationToken);
        if (!upstream.IsSuccessStatusCode)
        {
            return StatusCode((int)upstream.StatusCode, answerBody);
        }

        return Content(answerBody, "application/json");
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> LeaveServerSession(string sessionId, string? returnUrl = null)
    {
        if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var viewerId))
        {
            var nosebleedSeats = Resolve<NosebleedSeatManager>();
            var roomService = Resolve<GamePlayRoomService>();

            nosebleedSeats.Release(sessionId, viewerId);
            await roomService.DisconnectRoomParticipantSessionAsync(sessionId, viewerId, HttpContext.RequestAborted);
        }

        Response.Cookies.Delete(NosebleedViewerCookieName);

        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            return LocalRedirect(returnUrl);
        }

        return RedirectToAction("Index", "Games");
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> FlushServerSessionSave(int roomId, string? returnUrl = null, CancellationToken cancellationToken = default)
    {
        var roomService = Resolve<GamePlayRoomService>();

        var result = await roomService.FlushStandaloneRoomBatterySaveAsync(roomId, cancellationToken);
        TempData["Message"] = result.Success
            ? result.Message ?? "Flushed runtime save."
            : result.Error ?? "Unable to flush runtime save.";

        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            return LocalRedirect(returnUrl);
        }

        var room = await _db.GamePlayRooms.AsNoTracking().FirstOrDefaultAsync(x => x.Id == roomId, cancellationToken);
        if (room is not null)
        {
            return RedirectToRoute("PlayServerRoom", new { id = room.GameId, code = room.Code });
        }

        return RedirectToAction("Index", "Games");
    }

    private static string BuildNosebleedVideoProxyPath(string? videoMode, int? jpegQuality)
    {
        var normalizedVideoMode = string.Equals(videoMode, "raw", StringComparison.OrdinalIgnoreCase)
            ? "raw"
            : "jpeg";
        var query = new List<string> { $"video_mode={Uri.EscapeDataString(normalizedVideoMode)}" };
        if (normalizedVideoMode == "jpeg" && jpegQuality is >= 25 and <= 95)
        {
            query.Add($"jpeg_quality={jpegQuality.Value}");
        }

        return $"/ws/video?{string.Join("&", query)}";
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
            var tokenParam = $"token={Uri.EscapeDataString(token)}";
            builder.Query = string.IsNullOrWhiteSpace(builder.Query)
                ? tokenParam
                : $"{builder.Query.TrimStart('?')}&{tokenParam}";
        }

        return builder.Uri;
    }

    private static bool IsAllowedWebSocketOrigin(HttpRequest request)
    {
        var origin = request.Headers.Origin.ToString();
        if (string.IsNullOrWhiteSpace(origin) || !Uri.TryCreate(origin, UriKind.Absolute, out var originUri))
        {
            return false;
        }

        var requestHost = request.Host.Host;
        if (!string.Equals(originUri.Host, requestHost, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (request.Host.Port is not { } requestPort)
        {
            return originUri.IsDefaultPort;
        }

        return originUri.Port == requestPort;
    }

    private string GetOrCreateNosebleedViewerId()
    {
        if (HttpContext.Items.TryGetValue(NosebleedViewerCookieName, out var cached)
            && cached is string cachedViewerId
            && Guid.TryParse(cachedViewerId, out _))
        {
            return cachedViewerId;
        }

        if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var existing)
            && Guid.TryParse(existing, out _))
        {
            HttpContext.Items[NosebleedViewerCookieName] = existing;
            return existing;
        }

        var id = Guid.NewGuid().ToString("N");
        Response.Cookies.Append(NosebleedViewerCookieName, id, new CookieOptions
        {
            Path = "/",
            MaxAge = TimeSpan.FromDays(30),
            SameSite = SameSiteMode.None,
            Secure = true
        });
        HttpContext.Items[NosebleedViewerCookieName] = id;
        return id;
    }

    private string? ResolveViewerIdFromRequest()
    {
        if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var cookieViewerId)
            && Guid.TryParse(cookieViewerId, out _))
        {
            return cookieViewerId;
        }

        var fallbackViewerId = Request.Headers["X-Nosebleed-Viewer"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(fallbackViewerId))
        {
            fallbackViewerId = Request.Query["viewerId"].FirstOrDefault();
        }

        if (!Guid.TryParse(fallbackViewerId, out _))
        {
            return null;
        }

        Response.Cookies.Append(NosebleedViewerCookieName, fallbackViewerId, new CookieOptions
        {
            Path = "/",
            MaxAge = TimeSpan.FromDays(30),
            SameSite = SameSiteMode.None,
            Secure = true
        });
        HttpContext.Items[NosebleedViewerCookieName] = fallbackViewerId;
        return fallbackViewerId;
    }

    private async Task<string?> ResolveGameFileAbsolutePathAsync(GameFile file, CancellationToken cancellationToken)
    {
        var fileStorage = Resolve<GameFileStorage>();

        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            return fileStorage.GetAbsolutePath(file.StoragePath);
        }

        if (string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            return null;
        }

        var full = Path.GetFullPath(file.ExternalPath);
        var allowedRoots = await _db.LocalFolders
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
