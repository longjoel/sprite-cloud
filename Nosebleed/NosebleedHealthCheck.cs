using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedHealthCheck(IOptions<NosebleedOptions> options) : IHealthCheck
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

        return Task.FromResult(File.Exists(_options.BinaryPath)
            ? HealthCheckResult.Healthy($"Nosebleed binary present at '{_options.BinaryPath}'.")
            : HealthCheckResult.Unhealthy($"Nosebleed binary missing at '{_options.BinaryPath}'."));
    }
}