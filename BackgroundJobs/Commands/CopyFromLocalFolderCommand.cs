using System.Text.Json;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Local;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record CopyFromLocalFolderPayload(int LocalFolderId, string FullPath);

[BackgroundJobCommand("local.copy")]
public sealed class CopyFromLocalFolderCommand(
    AppDbContext db,
    UploadStagingStore stagingStore,
    IInternalJobsClient internalJobs) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<CopyFromLocalFolderPayload>(JobJson.Options);
        if (typed is null || typed.LocalFolderId <= 0 || string.IsNullOrWhiteSpace(typed.FullPath))
        {
            throw new InvalidOperationException("local.copy payload must include a localFolderId and fullPath.");
        }

        var folder = await db.LocalFolders.FirstOrDefaultAsync(f => f.Id == typed.LocalFolderId, cancellationToken);
        if (folder is null || !folder.Enabled)
        {
            throw new InvalidOperationException("Local folder not found or disabled.");
        }

        var fullPath = LocalPathGuard.NormalizeAndValidateFilePath(folder.RootPath, typed.FullPath);
        if (!File.Exists(fullPath))
        {
            throw new InvalidOperationException("Source file not found.");
        }

        var stagingDir = stagingStore.CreateStagingDirectory();
        var destPath = Path.Combine(stagingDir, Path.GetFileName(fullPath));

        await context.SetProgressPermilleAsync(0, cancellationToken);
        await context.LogInfoAsync($"Copying from local folder: {fullPath}", cancellationToken);

        await using (var src = File.OpenRead(fullPath))
        await using (var dst = File.Create(destPath))
        {
            await src.CopyToAsync(dst, cancellationToken);
        }

        await context.SetProgressPermilleAsync(800, cancellationToken);

        var importJobId = await internalJobs.EnqueueUploadImportAsync(stagingDir, cancellationToken);
        context.Logger.LogInformation("local.copy enqueued upload.import job {ImportJobId} for {Dest}", importJobId, destPath);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}

