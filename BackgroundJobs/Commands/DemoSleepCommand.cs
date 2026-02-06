using System.Text.Json;
using games_vault.BackgroundJobs;

namespace games_vault.BackgroundJobs.Commands;

public sealed record DemoSleepPayload(int Seconds);

[BackgroundJobCommand("demo.sleep")]
public sealed class DemoSleepCommand : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<DemoSleepPayload>(JobJson.Options) ?? new DemoSleepPayload(1);
        var seconds = Math.Clamp(typed.Seconds, 0, 60);

        for (var i = 0; i < seconds; i++)
        {
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
            await context.SetProgressPermilleAsync((i + 1) * 1000 / Math.Max(1, seconds), cancellationToken);
            await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
        }
    }
}
