using System.Text.Json;
using games_vault.Libretro.Import;
using Microsoft.Extensions.Options;

namespace games_vault.BackgroundJobs.Commands;

public sealed class RomWatchImportCommand(
    GameUploadImporter importer,
    UploadStagingStore stagingStore,
    IOptions<LibraryStorageOptions> storageOptions) : IBackgroundJobCommand
{
    private sealed record ImportCounts(int Scanned, int Matched, int Failed);

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = JsonSerializer.Deserialize<RomWatchImportPayload>(payload.GetRawText(), JobJson.Options);
        if (typed is null || typed.Paths is null || typed.Paths.Length == 0)
        {
            await context.LogWarnAsync("rom.watch: received empty payload, skipping.", cancellationToken);
            return;
        }

        var mode = storageOptions.Value.WatchFolder?.Mode ?? WatchFolderImportMode.Link;

        await context.LogInfoAsync(
            $"rom.watch: importing {typed.Paths.Length} file(s) (mode={mode}, batch={typed.TotalEnqueued} total enqueued)",
            cancellationToken);

        var counts = mode == WatchFolderImportMode.Copy
            ? await CopyModeAsync(context, typed.Paths, cancellationToken)
            : await LinkModeAsync(context, typed.Paths, cancellationToken);

        var permille = typed.TotalEnqueued > 0
            ? (int)((long)counts.Matched * 1000 / Math.Max(typed.TotalEnqueued, 1))
            : 1000;
        await context.SetProgressPermilleAsync(Math.Min(permille, 1000), cancellationToken);

        await context.LogInfoAsync(
            $"rom.watch: complete — {counts.Scanned} scanned, {counts.Matched} matched, {counts.Failed} failed",
            cancellationToken);
    }

    private async Task<ImportCounts> LinkModeAsync(
        BackgroundJobExecutionContext context,
        string[] paths,
        CancellationToken cancellationToken)
    {
        try
        {
            await context.SetProgressPermilleAsync(0, cancellationToken);
            var result = await importer.ImportLinkedLocalFilesAsync(paths, cancellationToken);

            foreach (var group in result.Groups)
            {
                await context.LogInfoAsync(
                    $"  Game #{group.GameId}: {group.GameName} ({group.SystemName}) — {group.MatchedFileCount} file(s)",
                    cancellationToken);
            }

            return new ImportCounts(result.TotalScannedFileCount, result.TotalMatchedFileCount, 0);
        }
        catch (InvalidOperationException ex) when (
            ex.Message.Contains("No eligible files", StringComparison.Ordinal) ||
            ex.Message.Contains("No files were", StringComparison.Ordinal))
        {
            await context.LogWarnAsync($"rom.watch (link): {ex.Message}", cancellationToken);
            return new ImportCounts(0, 0, 0);
        }
        catch (Exception ex)
        {
            await context.LogErrorAsync($"rom.watch (link): {ex.Message}", cancellationToken);
            return new ImportCounts(0, 0, paths.Length);
        }
    }

    private async Task<ImportCounts> CopyModeAsync(
        BackgroundJobExecutionContext context,
        string[] paths,
        CancellationToken cancellationToken)
    {
        var stagingDir = stagingStore.CreateStagingDirectory();
        var copiedCount = 0;

        try
        {
            foreach (var path in paths)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (!File.Exists(path))
                {
                    continue;
                }

                var fileName = Path.GetFileName(path);
                var dest = Path.Combine(stagingDir, fileName);

                // Avoid collisions in staging
                dest = MakeUnique(dest);
                File.Copy(path, dest);

                copiedCount++;
            }

            if (copiedCount == 0)
            {
                await context.LogWarnAsync("rom.watch (copy): no eligible files to copy to staging.", cancellationToken);
                return new ImportCounts(0, 0, 0);
            }

            await context.LogInfoAsync(
                $"rom.watch (copy): staged {copiedCount} file(s) to {stagingDir}", cancellationToken);
            await context.SetProgressPermilleAsync(0, cancellationToken);

            var result = await importer.ImportFromStagedDirectoryAsync(stagingDir, cancellationToken);

            foreach (var group in result.Groups)
            {
                await context.LogInfoAsync(
                    $"  Game #{group.GameId}: {group.GameName} ({group.SystemName}) — {group.MatchedFileCount} file(s)",
                    cancellationToken);
            }

            return new ImportCounts(result.TotalScannedFileCount, result.TotalMatchedFileCount, 0);
        }
        catch (Exception ex)
        {
            await context.LogErrorAsync($"rom.watch (copy): {ex.Message}", cancellationToken);
            return new ImportCounts(0, 0, paths.Length);
        }
        finally
        {
            stagingStore.TryDeleteDirectory(stagingDir);
        }
    }

    private static string MakeUnique(string destPath)
    {
        if (!File.Exists(destPath))
            return destPath;

        var dir = Path.GetDirectoryName(destPath)!;
        var name = Path.GetFileNameWithoutExtension(destPath);
        var ext = Path.GetExtension(destPath);

        for (var i = 2; i < 10_000; i++)
        {
            var candidate = Path.Combine(dir, $"{name} ({i}){ext}");
            if (!File.Exists(candidate))
                return candidate;
        }

        throw new IOException("Unable to create a unique filename in staging.");
    }
}
