using System.Text.Json;
using games_vault.Libretro;

namespace games_vault.BackgroundJobs.Commands;

public sealed class SyncLibretroDatabaseCommand(
    LibretroDatabaseSyncService syncService) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = JsonSerializer.Deserialize<SyncLibretroDatabasePayload>(payload.GetRawText(), JobJson.Options)
            ?? new SyncLibretroDatabasePayload();

        await context.LogInfoAsync($"Libretro DAT sync starting (force={typed.Force})...", cancellationToken);

        await syncService.SyncAsync(typed.Force, cancellationToken);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
        await context.LogInfoAsync("Libretro DAT sync complete.", cancellationToken);
    }
}
