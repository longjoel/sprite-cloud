using System.Text.Json;
using games_vault.Libretro.Import;

namespace games_vault.BackgroundJobs.Commands;

public sealed record ImportUploadStagingPayload(string StagingDirectory);

[BackgroundJobCommand("upload.import")]
public sealed class ImportUploadStagingCommand(
    GameUploadImporter importer,
    UploadStagingStore stagingStore) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<ImportUploadStagingPayload>(JobJson.Options);
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

            // Importer currently scans IFormFile; for background jobs we scan staged files directly.
            var result = await importer.ImportFromStagedDirectoryAsync(stagingDir, context, cancellationToken);

            context.Logger.LogInformation("upload.import done: scanned={Scanned} matched={Matched} games={Games}",
                result.TotalScannedFileCount, result.TotalMatchedFileCount, result.Groups.Count);

            await context.SetProgressPermilleAsync(1000, cancellationToken);
            succeeded = true;
        }
        finally
        {
            // Keep staging on failure so the job can be re-run/debugged.
            if (succeeded)
            {
                stagingStore.TryDeleteDirectory(stagingDir);
            }
        }
    }
}
