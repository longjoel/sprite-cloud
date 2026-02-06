using System.IO.Compression;
using System.Text.Json;
using games_vault.Data;
using games_vault.EverDrive;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

[BackgroundJobCommand("everdrivegb.zip")]
public sealed class ExportEverDriveGbZipCommand(
    AppDbContext db,
    GameFileStorage storage,
    IWebHostEnvironment env,
    IHttpClientFactory httpClientFactory) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<EverDriveGbExportPayload>(JobJson.Options);
        if (typed is null || typed.BatchId <= 0 || string.IsNullOrWhiteSpace(typed.FirmwareUrl))
        {
            throw new InvalidOperationException("everdrivegb.zip payload must include batchId and firmwareUrl.");
        }

        var (batchName, usable) = await EverDriveGbExportCommon.GetUsableFilesAsync(db, typed.BatchId, cancellationToken);

        var artifactsRoot = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data", "artifacts"));
        Directory.CreateDirectory(artifactsRoot);

        var workRoot = Path.Combine(artifactsRoot, "tmp", Guid.NewGuid().ToString("N"));
        var contentDir = Path.Combine(workRoot, "sd");
        Directory.CreateDirectory(contentDir);

        try
        {
            await context.LogInfoAsync($"EverDrive GB zip build starting: batch='{batchName}' id={typed.BatchId} files={usable.Count}", cancellationToken);
            await context.LogInfoAsync($"Firmware: {typed.FirmwareLabel} {typed.FirmwareUrl}", cancellationToken);

            await context.SetProgressPermilleAsync(10, cancellationToken);

            var firmwareZipPath = await EverDriveGbExportCommon.DownloadFirmwareZipAsync(
                env, httpClientFactory, msg => context.LogInfoAsync(msg, cancellationToken), typed.FirmwareUrl.Trim(), cancellationToken);
            await context.LogInfoAsync($"Firmware downloaded: {firmwareZipPath}", cancellationToken);

            await context.SetProgressPermilleAsync(150, cancellationToken);
            EverDriveGbExportCommon.ExtractFirmwareTo(firmwareZipPath, contentDir);
            await context.LogInfoAsync("Firmware extracted into SD root", cancellationToken);

            await context.SetProgressPermilleAsync(250, cancellationToken);

            var copied = 0;
            foreach (var chunk in usable.Chunk(25))
            {
                cancellationToken.ThrowIfCancellationRequested();
                copied += EverDriveGbExportCommon.CopyRomsToSdTree(storage, chunk, contentDir, msg => context.LogWarnAsync(msg, cancellationToken));
                await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
                await context.SetProgressPermilleAsync(250 + Math.Min(600, copied * 600 / usable.Count), cancellationToken);
            }

            if (copied == 0)
            {
                throw new InvalidOperationException("No files could be copied into the zip (stored file paths missing or unreadable).");
            }

            await context.LogInfoAsync($"ROM copy done: copied={copied} skipped={usable.Count - copied}", cancellationToken);
            await context.SetProgressPermilleAsync(850, cancellationToken);

            var zipName = $"everdrive-gb-{typed.BatchId}-{DateTime.UtcNow:yyyyMMdd-HHmmss}.zip";
            var zipAbs = Path.Combine(artifactsRoot, zipName);
            if (File.Exists(zipAbs))
            {
                File.Delete(zipAbs);
            }

            ZipFile.CreateFromDirectory(contentDir, zipAbs, CompressionLevel.Optimal, includeBaseDirectory: false);

            var rel = Path.Combine("App_Data", "artifacts", zipName).Replace('\\', '/');
            var info = new FileInfo(zipAbs);

            db.Artifacts.Add(new Artifact
            {
                FileName = zipName,
                StoragePath = rel,
                ContentType = "application/zip",
                SizeBytes = info.Exists ? info.Length : 0,
                CreatedUtc = DateTime.UtcNow,
                Source = $"everdrivegb.zip.batch:{typed.BatchId}"
            });
            await db.SaveChangesAsync(cancellationToken);

            await context.LogInfoAsync($"Artifact created: {zipName} ({info.Length} bytes)", cancellationToken);
            await context.SetProgressPermilleAsync(1000, cancellationToken);
        }
        finally
        {
            try { Directory.Delete(workRoot, recursive: true); } catch { }
        }
    }
}
