using games_vault.BackgroundJobs;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace games_vault.Web;

public sealed class WebPlayerBootstrapper(
    IServiceScopeFactory scopeFactory,
    WebPlayerAssetLocator locator,
    IOptions<WebPlayerOptions> options,
    IWebHostEnvironment env,
    ILogger<WebPlayerBootstrapper> logger) : IHostedService
{
    private readonly WebPlayerOptions _options = options.Value ?? new WebPlayerOptions();

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!_options.Enabled)
        {
            return;
        }

        if (locator.IsInstalled())
        {
            // If already installed, ensure our patch is applied (no network required).
            try
            {
                if (!string.IsNullOrWhiteSpace(env.WebRootPath))
                {
                    var folder = Path.GetFullPath(Path.Combine(env.WebRootPath, locator.BaseFolderRelative));
                    RetroArchWebPlayerPatch.ApplyToFolder(folder, logger);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to apply web player patch at startup.");
            }

            return;
        }

        if (!_options.AutoInstall)
        {
            logger.LogInformation("Web player assets missing; auto-install disabled.");
            return;
        }

        if (string.IsNullOrWhiteSpace(_options.RetroArchZipUrl))
        {
            logger.LogInformation("Web player assets missing; no RetroArchZipUrl configured.");
            return;
        }

        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var internalJobs = scope.ServiceProvider.GetRequiredService<IInternalJobsClient>();
            var jobId = await internalJobs.EnqueueWebPlayerInstallAsync(force: false, cancellationToken);
            logger.LogInformation("Queued web player install job #{JobId}.", jobId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to queue web player install job.");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
