using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace games_vault.Nosebleed;

public sealed class NosebleedReconciliationService(
    IServiceScopeFactory scopeFactory,
    ILogger<NosebleedReconciliationService> logger) : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(60);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(PollInterval, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var sessionManager = scope.ServiceProvider.GetRequiredService<NosebleedSessionManager>();
                var result = await sessionManager.ReconcileOrphansAsync(stoppingToken);
                if (result.AdoptedSessions > 0 || result.KilledOrphanProcesses > 0)
                {
                    logger.LogInformation(
                        "Periodic Nosebleed reconciliation: adopted={Adopted} killed={Killed} relinkedRooms={RelinkedRooms} relinkedCabinets={RelinkedCabinets}",
                        result.AdoptedSessions,
                        result.KilledOrphanProcesses,
                        result.RelinkedRooms,
                        result.RelinkedCabinets);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Periodic Nosebleed reconciliation failed");
            }

            try
            {
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
