using games_vault.Nosebleed;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class NosebleedHealthCheckTests
{
    [Fact]
    public async Task CheckHealthAsync_ReturnsHealthy_WhenNosebleedDisabled()
    {
        var healthCheck = new NosebleedHealthCheck(Options.Create(new NosebleedOptions
        {
            Enabled = false,
            BinaryPath = "/does/not/matter"
        }));

        var result = await healthCheck.CheckHealthAsync(new HealthCheckContext());

        Assert.Equal(HealthStatus.Healthy, result.Status);
        Assert.Equal("Nosebleed disabled.", result.Description);
    }

    [Fact]
    public async Task CheckHealthAsync_ReturnsHealthy_WhenEnabledAndBinaryExists()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), $"nosebleed-health-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        var binaryPath = Path.Combine(tempRoot, "nosebleed");
        await File.WriteAllTextAsync(binaryPath, string.Empty);

        try
        {
            var healthCheck = new NosebleedHealthCheck(Options.Create(new NosebleedOptions
            {
                Enabled = true,
                BinaryPath = binaryPath
            }));

            var result = await healthCheck.CheckHealthAsync(new HealthCheckContext());

            Assert.Equal(HealthStatus.Healthy, result.Status);
            Assert.Contains(binaryPath, result.Description);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task CheckHealthAsync_ReturnsUnhealthy_WhenEnabledAndBinaryMissing()
    {
        var binaryPath = Path.Combine(Path.GetTempPath(), $"nosebleed-missing-{Guid.NewGuid():N}", "nosebleed");
        var healthCheck = new NosebleedHealthCheck(Options.Create(new NosebleedOptions
        {
            Enabled = true,
            BinaryPath = binaryPath
        }));

        var result = await healthCheck.CheckHealthAsync(new HealthCheckContext());

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.Contains(binaryPath, result.Description);
    }
}