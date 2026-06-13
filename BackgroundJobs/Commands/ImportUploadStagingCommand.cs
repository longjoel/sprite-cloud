using System.Text.Json;
using games_vault.Libretro.Import;

namespace games_vault.BackgroundJobs.Commands;

public sealed class ImportUploadStagingCommand(
    GameUploadImporter importer,
    UploadStagingStore stagingStore) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = JsonSerializer.Deserialize<ImportUploadStagingPayload>(payload.GetRawText(), JobJson.Options);
        if (typed is null || string.IsNullOrWhiteSpace(typed.StagingDirectory))
        {
            throw new InvalidOperationException("upload.import payload must include a staging directory.");
        }

        var stagingDir = typed.StagingDirectory.Trim();
        if (!stagingStore.IsWithinRoot(stagingDir))
        {
            throw new InvalidOperationException("Invalid staging directory.");
        }

        var succeeded = false;
        try
        {
            await context.SetProgressPermilleAsync(0, cancellationToken);
            await context.LogInfoAsync($"Starting import from staging: {stagingDir}", cancellationToken);

            var result = await importer.ImportFromStagedDirectoryAsync(stagingDir, cancellationToken);

            await context.LogInfoAsync(
                $"Import complete: scanned={result.TotalScannedFileCount}, " +
                $"matched={result.TotalMatchedFileCount}, " +
                $"games={result.Groups.Count}",
                cancellationToken);

            if (result.Groups.Count > 0)
            {
                foreach (var group in result.Groups)
                {
                    await context.LogInfoAsync(
                        $"  Game #{group.GameId}: {group.GameName} ({group.SystemName}) — {group.MatchedFileCount} file(s)",
                        cancellationToken);
                }
            }

            await context.SetProgressPermilleAsync(1000, cancellationToken);
            succeeded = true;
        }
        finally
        {
            // Keep staging on failure so the job can be re-run or debugged.
            if (succeeded)
            {
                stagingStore.TryDeleteDirectory(stagingDir);
            }
        }
    }
}
