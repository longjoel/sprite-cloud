using games_vault.Data;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Arcade;

public sealed class ArcadeCabinetSupervisor(
    IServiceScopeFactory scopeFactory,
    NosebleedSessionManager nosebleedSessions,
    ILogger<ArcadeCabinetSupervisor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Give migrations/startup seeding a moment to finish before booting cabinets.
        await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Arcade cabinet supervisor tick failed.");
            }

            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
        }
    }

    public async Task TickAsync(CancellationToken cancellationToken = default)
    {
        nosebleedSessions.Cleanup();
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var resolver = scope.ServiceProvider.GetRequiredService<ArcadeGameFileResolver>();
        var active = nosebleedSessions.GetSessions().ToDictionary(x => x.SessionId, StringComparer.OrdinalIgnoreCase);

        var cabinets = await db.ArcadeCabinets
            .Include(x => x.Arcade)
            .Include(x => x.Game)
            .Where(x => x.IsEnabled && x.Arcade.IsEnabled)
            .OrderBy(x => x.SortOrder)
            .ToListAsync(cancellationToken);

        // Stop sessions for cabinets that have been disabled since last tick.
        var allCabinets = await db.ArcadeCabinets
            .Where(x => !x.IsEnabled && x.RuntimeSessionId != null)
            .ToListAsync(cancellationToken);
        foreach (var disabledCabinet in allCabinets)
        {
            if (!string.IsNullOrWhiteSpace(disabledCabinet.RuntimeSessionId))
            {
                logger.LogInformation(
                    "Stopping session {SessionId} for disabled cabinet {CabinetId}",
                    disabledCabinet.RuntimeSessionId, disabledCabinet.Id);
                nosebleedSessions.TryStop(disabledCabinet.RuntimeSessionId, "cabinet-disabled");
                disabledCabinet.RuntimeSessionId = null;
                disabledCabinet.LastSeenAliveUtc = null;
                disabledCabinet.LastStartedUtc = null;
            }
        }

        foreach (var cabinet in cabinets)
        {
            if (!cabinet.AutoRestart && string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId))
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(cabinet.RuntimeSessionId)
                && active.TryGetValue(cabinet.RuntimeSessionId, out var existing)
                && !existing.HasExited)
            {
                cabinet.LastSeenAliveUtc = DateTimeOffset.UtcNow;
                cabinet.LastError = null;
                continue;
            }

            var (file, contentPath, error) = await resolver.ResolveAsync(cabinet, cancellationToken);
            if (file is null || string.IsNullOrWhiteSpace(contentPath))
            {
                cabinet.LastError = error ?? "Cabinet ROM could not be resolved.";
                continue;
            }

            var result = await nosebleedSessions.StartOrReuseAsync(
                cabinet.GameId,
                file.Id,
                cabinet.Game.SystemName,
                contentPath,
                cancellationToken,
                instanceKey: $"arcade-cabinet:{cabinet.Id}");

            if (result.Success && result.Session is not null)
            {
                cabinet.GameFileId = file.Id;
                cabinet.RuntimeSessionId = result.Session.Id;
                cabinet.LastStartedUtc ??= result.Session.StartedUtc;
                cabinet.LastSeenAliveUtc = DateTimeOffset.UtcNow;
                cabinet.LastError = null;

                // Propagate the new RuntimeSessionId to the associated GamePlayRoom
                // so joining players reach the correct (fresh) session.
                var room = await db.GamePlayRooms
                    .Where(x => x.ArcadeCabinetId == cabinet.Id && x.Status == GamePlayRoomStatus.Active)
                    .OrderBy(x => x.Id)
                    .FirstOrDefaultAsync(cancellationToken);
                if (room is not null && room.NosebleedSessionId != result.Session.Id)
                {
                    room.NosebleedSessionId = result.Session.Id;
                    logger.LogInformation(
                        "Updated GamePlayRoom {RoomId} NosebleedSessionId to {SessionId} " +
                        "after cabinet {CabinetId} restart",
                        room.Id, result.Session.Id, cabinet.Id);
                }
            }
            else
            {
                cabinet.LastError = result.Error ?? "Failed to start arcade cabinet.";
            }
        }

        await db.SaveChangesAsync(cancellationToken);
    }
}
