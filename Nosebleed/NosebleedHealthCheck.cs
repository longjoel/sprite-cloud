using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedHealthCheck(
    IOptions<NosebleedOptions> options,
    NosebleedSessionManager sessionManager
) : IHealthCheck
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (!_options.Enabled)
        {
            return Task.FromResult(HealthCheckResult.Healthy("Nosebleed disabled."));
        }

        if (string.IsNullOrWhiteSpace(_options.BinaryPath))
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("Nosebleed is enabled but BinaryPath is empty."));
        }

        if (!File.Exists(_options.BinaryPath))
        {
            return Task.FromResult(HealthCheckResult.Unhealthy($"Nosebleed binary missing at '{_options.BinaryPath}'."));
        }

        // Check for zombie/hung sessions — processes that exited but weren't cleaned up
        sessionManager.Cleanup();
        var sessions = sessionManager.GetSessions();
        var exitedSessions = sessions.Where(s => s.HasExited).ToList();
        var aliveSessions = sessions.Where(s => !s.HasExited).ToList();

        if (exitedSessions.Count > 0)
        {
            return Task.FromResult(HealthCheckResult.Degraded(
                $"{exitedSessions.Count} zombie nosebleed session(s) (will be cleaned). "
                + $"{aliveSessions.Count} healthy session(s) active."));
        }

        return Task.FromResult(HealthCheckResult.Healthy(
            $"Nosebleed binary present. {aliveSessions.Count} active session(s)."));
    }
}
