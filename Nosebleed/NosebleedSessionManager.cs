using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedSessionManager(
    IOptions<NosebleedOptions> options,
    IServiceScopeFactory scopeFactory,
    NosebleedTicketSigner ticketSigner,
    IHttpClientFactory httpClientFactory,
    SystemCoreMappingResolver coreMappingResolver,
    NosebleedProcessInspector processInspector,
    NosebleedSeatManager seatManager,
    ILogger<NosebleedSessionManager> logger) : IDisposable
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();
    private readonly ConcurrentDictionary<string, ManagedSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _lock = new(1, 1);
    private int _nextPortOffset;
    private readonly CancellationTokenSource _drainCts = new();
    private int _shutdownStarted;

    public IReadOnlyList<NosebleedSessionSnapshot> GetSessions()
    {
        CleanupExitedSessions(disposeRemoved: false);
        return _sessions.Values
            .Select(ToSnapshot)
            .OrderBy(x => x.StartedUtc)
            .ToList();
    }

    public IReadOnlyList<int> GetManagedProcessIds()
    {
        return _sessions.Values
            .Where(x => !SafeHasExited(x.Process))
            .Select(x => SafeProcessId(x.Process))
            .Where(x => x.HasValue)
            .Select(x => x!.Value)
            .ToList();
    }

    public string CreateSessionId(int gameId, int fileId)
    {
        return $"games-vault-{gameId}-{fileId}-{Guid.NewGuid():N}";
    }

    public string GetRuntimeSaveDirectory(string sessionId)
    {
        sessionId = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            throw new ArgumentException("Session ID is required.", nameof(sessionId));
        }

        return Path.Combine(Path.GetFullPath(_options.SessionRoot), "save-data", SanitizeSessionId(sessionId));
    }

    public bool TryStop(string sessionId, string reason = "manual")
    {
        foreach (var pair in _sessions.ToArray())
        {
            if (!string.Equals(pair.Value.Session.Id, sessionId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!_sessions.TryRemove(pair.Key, out var removed))
            {
                return false;
            }

            logger.LogInformation("Stopping Nosebleed session {SessionId}: {Reason}", sessionId, reason);
            TryKill(removed.Process);
            removed.Process.Dispose();
            return true;
        }

        return false;
    }

    // Reset is sent over /ws/input as a command-only player token. It must stay
    // within Nosebleed's valid port range for auth validation, but it does not
    // need to correspond to an actually reserved player seat.
    private const int ResetCommandPort = 0;

    public async Task<(bool Success, string? Error)> TryRequestResetAsync(string sessionId, int port = 0, CancellationToken cancellationToken = default)
    {
        foreach (var pair in _sessions.ToArray())
        {
            if (!string.Equals(pair.Value.Session.Id, sessionId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var session = pair.Value.Session;
            if (SafeHasExited(pair.Value.Process))
            {
                return (false, "session process has exited");
            }

            try
            {
                using var socket = new ClientWebSocket();
                var baseUri = new Uri(session.BaseUrl);
                var uriBuilder = new UriBuilder(baseUri)
                {
                    Scheme = string.Equals(baseUri.Scheme, "https", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
                    Path = "/ws/input"
                };

                var commandPort = port == 0 ? ResetCommandPort : port;
                var resetToken = ticketSigner.CreatePlayerToken(sessionId, "games-vault-reset", commandPort);
                if (!string.IsNullOrWhiteSpace(resetToken))
                {
                    uriBuilder.Query = $"token={Uri.EscapeDataString(resetToken)}";
                }
                else if (!string.IsNullOrWhiteSpace(session.Token))
                {
                    uriBuilder.Query = $"token={Uri.EscapeDataString(session.Token)}";
                }

                await socket.ConnectAsync(uriBuilder.Uri, cancellationToken);

                var payload = JsonSerializer.Serialize(new
                {
                    type = "command",
                    command = "reset",
                    port = commandPort,
                    sequence = 1
                });
                var bytes = Encoding.UTF8.GetBytes(payload);
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);

                var buffer = new byte[4096];
                var receive = await socket.ReceiveAsync(buffer, cancellationToken);
                if (receive.MessageType == WebSocketMessageType.Text && receive.Count > 0)
                {
                    var response = Encoding.UTF8.GetString(buffer, 0, receive.Count);
                    try
                    {
                        using var document = JsonDocument.Parse(response);
                        if (document.RootElement.TryGetProperty("type", out var type) && type.GetString() == "error")
                        {
                            var message = document.RootElement.TryGetProperty("message", out var msg) ? msg.GetString() : "reset rejected";
                            return (false, message);
                        }
                    }
                    catch
                    {
                        // If we got a non-JSON response, treat the command as delivered if the socket stayed open.
                    }
                }

                return (true, null);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to request reset for Nosebleed session {SessionId}", sessionId);
                return (false, ex.Message);
            }
        }

        return (false, "session not found");
    }

    public void Cleanup() => CleanupExitedSessions(disposeRemoved: true);

    public async Task ShutdownAsync(CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref _shutdownStarted, 1) != 0)
        {
            return;
        }

        _drainCts.Cancel();
        await _lock.WaitAsync(cancellationToken);
        try
        {
            foreach (var pair in _sessions.ToArray())
            {
                if (_sessions.TryRemove(pair.Key, out var removed))
                {
                    TryKill(removed.Process);
                    removed.Process.Dispose();
                }
            }

            seatManager.ResetAll();
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<NosebleedReconcileResult> ReconcileOrphansAsync(CancellationToken cancellationToken = default)
    {
        CleanupExitedSessions(disposeRemoved: true);

        var orphanProcesses = processInspector.GetOrphanProcesses(GetManagedProcessIds());
        if (orphanProcesses.Count == 0)
        {
            return new NosebleedReconcileResult(0, 0, 0, 0);
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var cabinets = await db.ArcadeCabinets
            .Where(x => x.RuntimeSessionId != null)
            .ToListAsync(cancellationToken);
        var rooms = await db.GamePlayRooms
            .Where(x => x.Status == GamePlayRoomStatus.Active && x.NosebleedSessionId != null)
            .ToListAsync(cancellationToken);

        var cabinetsBySessionId = cabinets
            .Where(x => !string.IsNullOrWhiteSpace(x.RuntimeSessionId))
            .GroupBy(x => x.RuntimeSessionId!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(x => x.Key, x => x.OrderByDescending(c => c.Id).First(), StringComparer.OrdinalIgnoreCase);
        var roomsBySessionId = rooms
            .Where(x => !string.IsNullOrWhiteSpace(x.NosebleedSessionId))
            .GroupBy(x => x.NosebleedSessionId!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(x => x.Key, x => x.OrderByDescending(r => r.Id).First(), StringComparer.OrdinalIgnoreCase);
        var activeRoomByCabinetId = rooms
            .Where(x => x.ArcadeCabinetId is not null)
            .GroupBy(x => x.ArcadeCabinetId!.Value)
            .ToDictionary(x => x.Key, x => x.OrderByDescending(r => r.Id).First());

        var adopted = 0;
        var killed = 0;
        var relinkedRooms = 0;
        var relinkedCabinets = 0;

        foreach (var process in orphanProcesses)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (string.IsNullOrWhiteSpace(process.SessionId) || process.Port is null || process.Port <= 0)
            {
                if (processInspector.TryKillIfNosebleed(process.ProcessId))
                {
                    killed++;
                }

                continue;
            }

            cabinetsBySessionId.TryGetValue(process.SessionId, out var cabinet);
            roomsBySessionId.TryGetValue(process.SessionId, out var room);
            if (cabinet is null && room is null)
            {
                if (processInspector.TryKillIfNosebleed(process.ProcessId))
                {
                    killed++;
                }

                continue;
            }

            Process liveProcess;
            try
            {
                liveProcess = Process.GetProcessById(process.ProcessId);
                if (liveProcess.HasExited)
                {
                    liveProcess.Dispose();
                    continue;
                }
            }
            catch
            {
                continue;
            }

            var ownerGameId = cabinet?.GameId ?? room?.GameId;
            var ownerFileId = cabinet?.GameFileId ?? room?.GameFileId;
            if (ownerGameId is null || ownerFileId is null || string.IsNullOrWhiteSpace(process.CorePath) || string.IsNullOrWhiteSpace(process.ContentPath))
            {
                liveProcess.Dispose();
                if (processInspector.TryKillIfNosebleed(process.ProcessId))
                {
                    killed++;
                }

                continue;
            }

            var session = new NosebleedSession(
                process.SessionId,
                ownerGameId.Value,
                ownerFileId.Value,
                process.Port.Value,
                BuildBaseUrl(process.Port.Value),
                BuildLocalUrl(process.Port.Value),
                ticketSigner.CreatePlayerToken(process.SessionId, "games-vault-user", 0),
                ReadStartedUtc(liveProcess),
                Path.GetFullPath(process.CorePath),
                Path.GetFullPath(process.ContentPath));

            var key = cabinet is not null ? $"arcade-cabinet:{cabinet.Id}" : $"room:{room!.Id}";
            _sessions[key] = new ManagedSession(session, liveProcess);
            adopted++;
            seatManager.Reset(sessionId: process.SessionId);

            if (cabinet is not null)
            {
                if (!string.Equals(cabinet.RuntimeSessionId, process.SessionId, StringComparison.OrdinalIgnoreCase))
                {
                    cabinet.RuntimeSessionId = process.SessionId;
                    relinkedCabinets++;
                }

                cabinet.LastSeenAliveUtc = DateTimeOffset.UtcNow;
                cabinet.LastStartedUtc ??= session.StartedUtc;
                cabinet.LastError = null;

                if (activeRoomByCabinetId.TryGetValue(cabinet.Id, out var arcadeRoom)
                    && !string.Equals(arcadeRoom.NosebleedSessionId, process.SessionId, StringComparison.OrdinalIgnoreCase))
                {
                    arcadeRoom.NosebleedSessionId = process.SessionId;
                    relinkedRooms++;
                }
            }

            if (room is not null && !string.Equals(room.NosebleedSessionId, process.SessionId, StringComparison.OrdinalIgnoreCase))
            {
                room.NosebleedSessionId = process.SessionId;
                relinkedRooms++;
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        return new NosebleedReconcileResult(adopted, killed, relinkedRooms, relinkedCabinets);
    }

    public Task<NosebleedStartResult> StartOrReuseAsync(
        int gameId,
        int fileId,
        string systemName,
        string contentPath,
        CancellationToken cancellationToken = default,
        string? instanceKey = null,
        string? sessionIdOverride = null)
        => StartAsync(
            gameId,
            fileId,
            systemName,
            contentPath,
            cancellationToken,
            instanceKey,
            sessionIdOverride,
            forceNew: false,
            allowOverCapacity: false);

    public Task<NosebleedStartResult> StartFreshAsync(
        int gameId,
        int fileId,
        string systemName,
        string contentPath,
        CancellationToken cancellationToken = default,
        string? instanceKey = null,
        string? sessionIdOverride = null,
        bool allowOverCapacity = true)
        => StartAsync(
            gameId,
            fileId,
            systemName,
            contentPath,
            cancellationToken,
            instanceKey,
            sessionIdOverride,
            forceNew: true,
            allowOverCapacity: allowOverCapacity);

    private async Task<NosebleedStartResult> StartAsync(
        int gameId,
        int fileId,
        string systemName,
        string contentPath,
        CancellationToken cancellationToken,
        string? instanceKey,
        string? sessionIdOverride,
        bool forceNew,
        bool allowOverCapacity)
    {
        if (!_options.Enabled)
        {
            return NosebleedStartResult.Fail("Server-side playback is disabled. Enable Nosebleed in appsettings.");
        }

        if (!File.Exists(_options.BinaryPath))
        {
            return NosebleedStartResult.Fail("Streaming service is not available. The streaming binary has not been installed.");
        }

        if (!File.Exists(contentPath))
        {
            return NosebleedStartResult.Fail("The requested game file could not be found. It may have been moved or deleted.");
        }

        var coreName = coreMappingResolver.ResolveNativeCore(systemName);
        var coreWasInstalledOnDemand = false;
        await using var installerScope = scopeFactory.CreateAsyncScope();
        var coreInstaller = installerScope.ServiceProvider.GetRequiredService<LibretroCoreInstaller>();
        if (string.IsNullOrWhiteSpace(coreName))
        {
            var ensureResult = await coreInstaller.EnsureCoreAvailableAsync(systemName, cancellationToken: cancellationToken);
            if (!ensureResult.Available)
            {
                return NosebleedStartResult.Fail($"No native core mapping found for '{systemName}'.");
            }

            coreWasInstalledOnDemand = ensureResult.Installed;
            coreName = coreMappingResolver.ResolveNativeCore(systemName);
            if (string.IsNullOrWhiteSpace(coreName))
            {
                return NosebleedStartResult.Fail($"No native core mapping found for '{systemName}' after installing the known core.");
            }
        }

        var corePath = Path.IsPathRooted(coreName) ? coreName : Path.Combine(_options.CoreRoot, coreName);
        corePath = Path.GetFullPath(corePath);
        if (!File.Exists(corePath))
        {
            var ensureResult = await coreInstaller.EnsureCoreAvailableAsync(systemName, coreName, cancellationToken);
            if (!ensureResult.Available)
            {
                return NosebleedStartResult.Fail($"Nosebleed core not found at '{corePath}'.");
            }

            coreWasInstalledOnDemand |= ensureResult.Installed;
            corePath = Path.IsPathRooted(coreName) ? coreName : Path.Combine(_options.CoreRoot, coreName);
            corePath = Path.GetFullPath(corePath);
            if (!File.Exists(corePath))
            {
                return NosebleedStartResult.Fail($"Nosebleed core not found at '{corePath}'.");
            }
        }

        // Validate contentPath — defense-in-depth: ensure the file actually
        // exists before launching nosebleed with it as game content.
        var resolvedContent = Path.GetFullPath(contentPath);
        if (!File.Exists(resolvedContent))
        {
            return NosebleedStartResult.Fail($"Content file not found at '{resolvedContent}'.");
        }

        var key = string.IsNullOrWhiteSpace(instanceKey)
            ? $"{gameId}:{fileId}:{corePath}:{contentPath}"
            : instanceKey.Trim();
        if (!forceNew && _sessions.TryGetValue(key, out var existing) && !existing.Process.HasExited)
        {
            return NosebleedStartResult.Ok(existing.Session);
        }

        await _lock.WaitAsync(cancellationToken);
        Process? process = null;
        NosebleedSession? session = null;
        try
        {
            CleanupExitedSessions(disposeRemoved: true);

            if (!forceNew && _sessions.TryGetValue(key, out existing) && !existing.Process.HasExited)
            {
                return NosebleedStartResult.Ok(existing.Session);
            }

            // If forceNew, kill any existing session for this key before starting a fresh one.
            // Prevents orphaned processes when concurrent StartFreshAsync calls race.
            if (forceNew && _sessions.TryGetValue(key, out var toReplace) && !toReplace.Process.HasExited)
            {
                logger.LogInformation(
                    "Replacing existing Nosebleed session {SessionId} ({Reason})",
                    toReplace.Session.Id, "forceNew");
                _sessions.TryRemove(key, out _);
                TryKill(toReplace.Process);
                toReplace.Process.Dispose();
            }

            if (!allowOverCapacity && _sessions.Count >= Math.Max(1, _options.MaxSessions))
            {
                return NosebleedStartResult.Fail($"Nosebleed session limit reached ({_options.MaxSessions}). Stop an existing session and try again.");
            }

            Directory.CreateDirectory(_options.SessionRoot);
            var port = AllocatePort();
            var sessionId = string.IsNullOrWhiteSpace(sessionIdOverride)
                ? CreateSessionId(gameId, fileId)
                : sessionIdOverride.Trim();
            var runtimeSaveDirectory = GetRuntimeSaveDirectory(sessionId);
            Directory.CreateDirectory(runtimeSaveDirectory);
            var baseUrl = $"{_options.PublicScheme}://{_options.PublicHost}:{port}";
            var healthUrl = $"http://127.0.0.1:{port}";
            var token = ticketSigner.CreatePlayerToken(sessionId, $"games-vault-user", 0);

            var psi = new ProcessStartInfo
            {
                FileName = _options.BinaryPath,
                WorkingDirectory = Path.GetDirectoryName(_options.BinaryPath) ?? "/",
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false
            };

            psi.ArgumentList.Add("--listen");
            psi.ArgumentList.Add($"0.0.0.0:{port}");
            psi.ArgumentList.Add("--core");
            psi.ArgumentList.Add(corePath);
            psi.ArgumentList.Add("--content");
            psi.ArgumentList.Add(Path.GetFullPath(contentPath));
            psi.ArgumentList.Add("--fps");
            psi.ArgumentList.Add(_options.Fps.ToString(System.Globalization.CultureInfo.InvariantCulture));
            psi.ArgumentList.Add("--session-root");
            psi.ArgumentList.Add(_options.SessionRoot);
            psi.ArgumentList.Add("--session-id");
            psi.ArgumentList.Add(sessionId);
            if (_options.CopyContentToSession)
            {
                psi.ArgumentList.Add("--session-copy-content");
            }
            var streamSettings = GetStreamSettings();
            psi.Environment["NOSEBLEED_SAVE_DIR"] = runtimeSaveDirectory;
            psi.Environment["NOSEBLEED_MEDIA_BACKEND"] = streamSettings.MediaBackend;

            if (!string.IsNullOrEmpty(_options.TurnSecret))
            {
                psi.Environment["NOSEBLEED_TURN_SECRET"] = _options.TurnSecret;
            }
            if (!string.IsNullOrEmpty(_options.TurnHost))
            {
                psi.Environment["NOSEBLEED_TURN_HOST"] = _options.TurnHost;
            }
            if (!string.IsNullOrEmpty(_options.TurnUrlInternal))
            {
                psi.Environment["NOSEBLEED_TURN_URL_INTERNAL"] = _options.TurnUrlInternal;
            }

            var publicHost = _options.PublicHost;
            if (!string.IsNullOrWhiteSpace(publicHost) &&
                System.Net.IPAddress.TryParse(publicHost, out var parsedIp))
            {
                psi.Environment["NOSEBLEED_PUBLIC_IP"] = parsedIp.ToString();
            }
            else if (!string.IsNullOrWhiteSpace(publicHost))
            {
                try
                {
                    var addresses = System.Net.Dns.GetHostAddresses(publicHost);
                    var ipv4 = Array.Find(addresses, a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork);
                    if (ipv4 is not null)
                    {
                        psi.Environment["NOSEBLEED_PUBLIC_IP"] = ipv4.ToString();
                    }
                }
                catch
                {
                    // Non-fatal; ICE will fall back to container IP (same as before)
                }
            }

            if (_options.RequireAuth)
            {
                psi.ArgumentList.Add("--require-auth");
                psi.Environment["NOSEBLEED_AUTH_SECRET"] = File.ReadAllText(_options.AuthSecretPath).Trim();
            }

            process = Process.Start(psi);
            if (process is null)
            {
                return NosebleedStartResult.Fail("Failed to start Nosebleed process.");
            }

            _ = Task.Run(() => DrainAsync(process.StandardOutput, sessionId, false, _drainCts.Token), _drainCts.Token);
            _ = Task.Run(() => DrainAsync(process.StandardError, sessionId, true, _drainCts.Token), _drainCts.Token);

            // Register in _sessions and release the lock *before* waiting for health.
            // This prevents request threads from blocking on GetSessions() →
            // CleanupExitedSessions() → _lock.Wait() while we poll the process.
            session = new NosebleedSession(
                sessionId,
                gameId,
                fileId,
                port,
                baseUrl,
                healthUrl,
                token,
                DateTimeOffset.UtcNow,
                corePath,
                Path.GetFullPath(contentPath));
            _sessions[key] = new ManagedSession(session, process);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to start Nosebleed session for game {GameId} file {FileId}", gameId, fileId);
            return NosebleedStartResult.Fail(ex.Message);
        }
        finally
        {
            _lock.Release();
        }

        // Health check outside the lock — this can take up to 8s and must not
        // block request threads that call GetSessions().
        var healthy = await WaitForHealthAsync(session!.LocalUrl, process!, cancellationToken);
        if (!healthy)
        {
            var exit = process!.HasExited ? $" Process exited with code {process.ExitCode}." : "";
            TryKill(process);
            process.Dispose();

            await _lock.WaitAsync(cancellationToken);
            try
            {
                _sessions.TryRemove(key, out _);
            }
            finally
            {
                _lock.Release();
            }

            return NosebleedStartResult.Fail($"Nosebleed did not become healthy at {session.BaseUrl}.{exit}");
        }

        if (coreWasInstalledOnDemand)
        {
            logger.LogInformation("Installed libretro core on demand for system {SystemName}: {CorePath}", systemName, corePath);
        }
        return NosebleedStartResult.Ok(session);
    }

    private NosebleedStreamSettings GetStreamSettings()
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            return scope.ServiceProvider.GetService<NosebleedStreamSettingsStore>()?.Get() ?? new NosebleedStreamSettings();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to load Nosebleed stream settings; falling back to defaults.");
            return new NosebleedStreamSettings();
        }
    }

    private int AllocatePort()
    {
        var max = Math.Max(1, _options.MaxSessions);
        for (var i = 0; i < max * 4; i++)
        {
            var offset = Interlocked.Increment(ref _nextPortOffset) - 1;
            var port = _options.BaseListenPort + offset % (max * 4);
            if (_sessions.Values.All(s => s.Session.Port != port || SafeHasExited(s.Process)))
            {
                return port;
            }
        }

        return _options.BaseListenPort + Random.Shared.Next(1000, 5000);
    }

    private async Task<bool> WaitForHealthAsync(string baseUrl, Process process, CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(1);
        var deadline = DateTimeOffset.UtcNow.AddSeconds(8);
        while (DateTimeOffset.UtcNow < deadline && !process.HasExited && !cancellationToken.IsCancellationRequested)
        {
            try
            {
                var response = await client.GetAsync($"{baseUrl}/healthz", cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    return true;
                }
            }
            catch
            {
                // keep polling until timeout
            }
            await Task.Delay(250, cancellationToken);
        }
        return false;
    }

    private string BuildBaseUrl(int port)
    {
        return $"{_options.PublicScheme}://{_options.PublicHost}:{port}";
    }

    private static string BuildLocalUrl(int port)
    {
        return $"http://127.0.0.1:{port}";
    }

    private void CleanupExitedSessions(bool disposeRemoved = true)
    {
        // Non-blocking try-enter: if the lock is held (e.g. StartOrReuseAsync is
        // starting a session), skip cleanup and return immediately. This prevents
        // request threads from blocking on _lock.Wait() while a Nosebleed process
        // is being started (which can take up to 8s for WaitForHealthAsync).
        if (!_lock.Wait(0))
        {
            return;
        }

        try
        {
            foreach (var pair in _sessions.ToArray())
            {
                if (SafeHasExited(pair.Value.Process))
                {
                    if (_sessions.TryRemove(pair.Key, out var removed) && disposeRemoved)
                    {
                        removed.Process.Dispose();
                    }
                }
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    private static NosebleedSessionSnapshot ToSnapshot(ManagedSession managed)
    {
        var process = managed.Process;
        var session = managed.Session;
        var now = DateTimeOffset.UtcNow;
        return new NosebleedSessionSnapshot(
            session.Id,
            session.GameId,
            session.FileId,
            session.Port,
            session.BaseUrl,
            session.LocalUrl,
            session.StartedUtc,
            session.CorePath,
            session.ContentPath,
            SafeProcessId(process) ?? 0,
            SafeHasExited(process),
            now >= session.StartedUtc ? now - session.StartedUtc : TimeSpan.Zero);
    }

    private static int? SafeProcessId(Process process)
    {
        try
        {
            return process.Id;
        }
        catch
        {
            return null;
        }
    }

    private static bool SafeHasExited(Process process)
    {
        try
        {
            return process.HasExited;
        }
        catch
        {
            return true;
        }
    }

    private static DateTimeOffset ReadStartedUtc(Process process)
    {
        try
        {
            return new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero);
        }
        catch
        {
            return DateTimeOffset.UtcNow;
        }
    }

    private static string SanitizeSessionId(string raw)
    {
        var chars = raw.Trim()
            .Select(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '_')
            .ToArray();
        return chars.Length == 0 ? "session" : new string(chars);
    }

    private async Task DrainAsync(StreamReader reader, string sessionId, bool error, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && await reader.ReadLineAsync(ct) is { } line)
            {
                if (error)
                {
                    logger.LogWarning("nosebleed[{SessionId}] {Line}", sessionId, line);
                }
                else
                {
                    logger.LogInformation("nosebleed[{SessionId}] {Line}", sessionId, line);
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Stopped reading Nosebleed output for {SessionId}", sessionId);
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // best effort
        }
    }

    public void Dispose()
    {
        ShutdownAsync().GetAwaiter().GetResult();
        _drainCts.Dispose();
        _lock.Dispose();
    }

    private sealed record ManagedSession(NosebleedSession Session, Process Process);
}

public sealed record NosebleedReconcileResult(
    int AdoptedSessions,
    int KilledOrphanProcesses,
    int RelinkedRooms,
    int RelinkedCabinets);
