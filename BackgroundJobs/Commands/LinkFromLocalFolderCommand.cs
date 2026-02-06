using System.Text.Json;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Local;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record LinkFromLocalFolderPayload(int LocalFolderId, string FullPath);

[BackgroundJobCommand("local.link")]
public sealed class LinkFromLocalFolderCommand(
    AppDbContext db,
    GameUploadImporter importer) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<LinkFromLocalFolderPayload>(JobJson.Options);
        if (typed is null || typed.LocalFolderId <= 0 || string.IsNullOrWhiteSpace(typed.FullPath))
        {
            throw new InvalidOperationException("local.link payload must include a localFolderId and fullPath.");
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

        await context.SetProgressPermilleAsync(0, cancellationToken);
        await context.LogInfoAsync($"Linking local file: {fullPath}", cancellationToken);

        await context.SetProgressPermilleAsync(50, cancellationToken);
        var result = await importer.ImportLinkedLocalFilesAsync([fullPath], cancellationToken);
        await context.SetProgressPermilleAsync(950, cancellationToken);

        context.Logger.LogInformation("local.link done: scanned={Scanned} matched={Matched} games={Games}",
            result.TotalScannedFileCount, result.TotalMatchedFileCount, result.Groups.Count);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}

