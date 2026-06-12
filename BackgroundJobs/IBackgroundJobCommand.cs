using System.Text.Json;

namespace games_vault.BackgroundJobs;

public interface IBackgroundJobCommand
{
    Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken);
}
