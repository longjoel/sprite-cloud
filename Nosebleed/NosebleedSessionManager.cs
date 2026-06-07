using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedSessionManager(
    IOptions<NosebleedOptions> options,
    IServiceScopeFactory scopeFactory,
    NosebleedTicketSigner ticketSigner,
    IHttpClientFactory httpClientFactory,
    ILogger<NosebleedSessionManager> logger) : IDisposable
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();
    private readonly ConcurrentDictionary<string, ManagedSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _lock = new(1, 1);
    private int _nextPortOffset;

    public IReadOnlyList<NosebleedSessionSnapshot> GetSessions()
    {
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
            if (pair.Value.Process.HasExited)
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
            return NosebleedStartResult.Fail($"Nosebleed binary not found at '{_options.BinaryPath}'. Build/install nosebleed first.");
        }

        if (!File.Exists(contentPath))
        {
            return NosebleedStartResult.Fail($"ROM file not found at '{contentPath}'.");
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        var coreMappingResolver = scope.ServiceProvider.GetRequiredService<SystemCoreMappingResolver>();
        var coreInstaller = scope.ServiceProvider.GetRequiredService<LibretroCoreInstaller>();
        var automapper = scope.ServiceProvider.GetRequiredService<SystemCoreAutomapper>();
        var coreName = await coreMappingResolver.ResolveNativeCoreAsync(systemName, cancellationToken);
        var coreWasInstalledOnDemand = false;
        if (string.IsNullOrWhiteSpace(coreName))
        {
            var ensureResult = await coreInstaller.EnsureCoreAvailableAsync(systemName, cancellationToken: cancellationToken);
            if (!ensureResult.Available)
            {
                return NosebleedStartResult.Fail($"No native core mapping found for '{systemName}'. Admins can configure it under System Core Mappings.");
            }

            coreWasInstalledOnDemand = ensureResult.Installed;
            await automapper.AutoMapDetectedSystemsAsync(GetInstalledNativeCores(), cancellationToken);
            coreName = await coreMappingResolver.ResolveNativeCoreAsync(systemName, cancellationToken);
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

        var key = string.IsNullOrWhiteSpace(instanceKey)
            ? $"{gameId}:{fileId}:{corePath}:{contentPath}"
            : instanceKey.Trim();
        if (!forceNew && _sessions.TryGetValue(key, out var existing) && !existing.Process.HasExited)
        {
            return NosebleedStartResult.Ok(existing.Session);
        }

        await _lock.WaitAsync(cancellationToken);
        try
        {
            CleanupExitedSessions(disposeRemoved: true);

            if (!forceNew && _sessions.TryGetValue(key, out existing) && !existing.Process.HasExited)
            {
                return NosebleedStartResult.Ok(existing.Session);
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

            if (_options.RequireAuth)
            {
                psi.ArgumentList.Add("--require-auth");
                psi.Environment["NOSEBLEED_AUTH_SECRET"] = File.ReadAllText(_options.AuthSecretPath).Trim();
            }

            var process = Process.Start(psi);
            if (process is null)
            {
                return NosebleedStartResult.Fail("Failed to start Nosebleed process.");
            }

            _ = Task.Run(() => DrainAsync(process.StandardOutput, sessionId, false));
            _ = Task.Run(() => DrainAsync(process.StandardError, sessionId, true));

            var healthy = await WaitForHealthAsync(baseUrl, process, cancellationToken);
            if (!healthy)
            {
                var exit = process.HasExited ? $" Process exited with code {process.ExitCode}." : "";
                TryKill(process);
                return NosebleedStartResult.Fail($"Nosebleed did not become healthy at {baseUrl}.{exit}");
            }

            var session = new NosebleedSession(
                sessionId,
                gameId,
                fileId,
                port,
                baseUrl,
                token,
                DateTimeOffset.UtcNow,
                corePath,
                Path.GetFullPath(contentPath));
            _sessions[key] = new ManagedSession(session, process);
            if (coreWasInstalledOnDemand)
            {
                logger.LogInformation("Installed libretro core on demand for system {SystemName}: {CorePath}", systemName, corePath);
            }
            return NosebleedStartResult.Ok(session);
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
            if (_sessions.Values.All(s => s.Session.Port != port || s.Process.HasExited))
            {
                return port;
            }
        }

        return _options.BaseListenPort + Random.Shared.Next(1000, 5000);
    }

    private IReadOnlyList<string> GetInstalledNativeCores()
    {
        if (string.IsNullOrWhiteSpace(_options.CoreRoot) || !Directory.Exists(_options.CoreRoot))
        {
            return [];
        }

        return Directory.EnumerateFiles(_options.CoreRoot, "*_libretro.so", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFileName)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .ToList();
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

    private void CleanupExitedSessions(bool disposeRemoved = true)
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

    private static string SanitizeSessionId(string raw)
    {
        var chars = raw.Trim()
            .Select(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '_')
            .ToArray();
        return chars.Length == 0 ? "session" : new string(chars);
    }

    private async Task DrainAsync(StreamReader reader, string sessionId, bool error)
    {
        try
        {
            while (await reader.ReadLineAsync() is { } line)
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
        _lock.Dispose();
        foreach (var session in _sessions.Values)
        {
            TryKill(session.Process);
            session.Process.Dispose();
        }
    }

    private sealed record ManagedSession(NosebleedSession Session, Process Process);
}
