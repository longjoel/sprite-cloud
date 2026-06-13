using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace games_vault.Nosebleed;

/// <summary>
/// A simple health check that verifies the database is reachable by executing
/// a trivial query. Replaces <c>AddDbContextCheck</c> which was exhibiting
/// hangs on the second invocation in the gv-test environment.
/// </summary>
public sealed class DatabaseHealthCheck(
    IServiceScopeFactory scopeFactory,
    ILogger<DatabaseHealthCheck> logger) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<Data.AppDbContext>();

            // Use ExecuteSqlRaw with a trivial SELECT to avoid any EF Core health-check quirks
            var result = await db.Database
                .ExecuteSqlRawAsync("SELECT 1", cancellationToken);

            logger.LogDebug("Database health check succeeded (rows={Rows}).", result);

            return HealthCheckResult.Healthy("Database is reachable.");
        }
        catch (OperationCanceledException)
        {
            logger.LogWarning("Database health check cancelled.");
            return HealthCheckResult.Unhealthy("Health check was cancelled.");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Database health check failed.");
            return HealthCheckResult.Unhealthy($"Database check failed: {ex.Message}");
        }
    }
}
