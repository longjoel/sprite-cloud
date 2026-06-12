using games_vault.Nosebleed;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;

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
        }), null!);

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
            var nosebleedOptions = Options.Create(new NosebleedOptions
            {
                Enabled = true,
                BinaryPath = binaryPath
            });
            var sessionManager = new NosebleedSessionManager(
                nosebleedOptions,
                Mock.Of<IServiceScopeFactory>(),
                new NosebleedTicketSigner(nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance),
                Mock.Of<IHttpClientFactory>(),
                new SystemCoreMappingResolver(nosebleedOptions),
                new NosebleedProcessInspector(nosebleedOptions),
                new NosebleedSeatManager(nosebleedOptions),
                NullLogger<NosebleedSessionManager>.Instance);

            var healthCheck = new NosebleedHealthCheck(nosebleedOptions, sessionManager);

            var result = await healthCheck.CheckHealthAsync(new HealthCheckContext());

            Assert.Equal(HealthStatus.Healthy, result.Status);
            Assert.Contains("Nosebleed binary present", result.Description);
            Assert.Contains("0 active session(s)", result.Description);
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
        }), null!);

        var result = await healthCheck.CheckHealthAsync(new HealthCheckContext());

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.Contains(binaryPath, result.Description);
    }
}
