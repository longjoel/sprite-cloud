using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedSessionManager(
    IOptions<NosebleedOptions> options,
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

    public void Cleanup() => CleanupExitedSessions(disposeRemoved: true);

    public async Task<NosebleedStartResult> StartOrReuseAsync(
        int gameId,
        int fileId,
        string systemName,
        string contentPath,
        CancellationToken cancellationToken = default)
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

        if (!_options.SystemCores.TryGetValue(systemName, out var coreName) || string.IsNullOrWhiteSpace(coreName))
        {
            return NosebleedStartResult.Fail($"No Nosebleed native core mapping found for '{systemName}'. Configure Nosebleed:SystemCores.");
        }

        var corePath = Path.IsPathRooted(coreName) ? coreName : Path.Combine(_options.CoreRoot, coreName);
        corePath = Path.GetFullPath(corePath);
        if (!File.Exists(corePath))
        {
            return NosebleedStartResult.Fail($"Nosebleed core not found at '{corePath}'.");
        }

        var key = $"{gameId}:{fileId}:{corePath}:{contentPath}";
        if (_sessions.TryGetValue(key, out var existing) && !existing.Process.HasExited)
        {
            return NosebleedStartResult.Ok(existing.Session);
        }

        await _lock.WaitAsync(cancellationToken);
        try
        {
            CleanupExitedSessions(disposeRemoved: true);

            if (_sessions.TryGetValue(key, out existing) && !existing.Process.HasExited)
            {
                return NosebleedStartResult.Ok(existing.Session);
            }

            if (_sessions.Count >= Math.Max(1, _options.MaxSessions))
            {
                return NosebleedStartResult.Fail($"Nosebleed session limit reached ({_options.MaxSessions}). Stop an existing session and try again.");
            }

            Directory.CreateDirectory(_options.SessionRoot);
            var port = AllocatePort();
            var sessionId = $"games-vault-{gameId}-{fileId}-{Guid.NewGuid():N}";
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
