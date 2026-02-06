using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using games_vault.Data;
using games_vault.EverDrive;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

[BackgroundJobCommand("everdrivegb.image")]
public sealed class ExportEverDriveGbImageCommand(
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
            throw new InvalidOperationException("everdrivegb.image payload must include batchId and firmwareUrl.");
        }

        var (batchName, usable) = await EverDriveGbExportCommon.GetUsableFilesAsync(db, typed.BatchId, cancellationToken);

        var artifactsRoot = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data", "artifacts"));
        Directory.CreateDirectory(artifactsRoot);

        var workRoot = Path.Combine(artifactsRoot, "tmp", Guid.NewGuid().ToString("N"));
        var contentDir = Path.Combine(workRoot, "sd");
        Directory.CreateDirectory(contentDir);

        try
        {
            await context.LogInfoAsync($"EverDrive GB image build starting: batch='{batchName}' id={typed.BatchId} files={usable.Count}", cancellationToken);
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
                throw new InvalidOperationException("No files could be copied into the image (stored file paths missing or unreadable).");
            }

            await context.LogInfoAsync($"ROM copy done: copied={copied} skipped={usable.Count - copied}", cancellationToken);
            await context.SetProgressPermilleAsync(850, cancellationToken);

            // Build 1 GiB FAT32 "superfloppy" image and copy contents using mtools.
            var imageName = $"everdrive-gb-{typed.BatchId}-{DateTime.UtcNow:yyyyMMdd-HHmmss}.img";
            var imageAbs = Path.Combine(artifactsRoot, imageName);
            await CreateFatImageAsync(context, contentDir, imageAbs, cancellationToken);

            var rel = Path.Combine("App_Data", "artifacts", imageName).Replace('\\', '/');
            var info = new FileInfo(imageAbs);

            db.Artifacts.Add(new Artifact
            {
                FileName = imageName,
                StoragePath = rel,
                ContentType = "application/octet-stream",
                SizeBytes = info.Exists ? info.Length : 0,
                CreatedUtc = DateTime.UtcNow,
                Source = $"everdrivegb.batch:{typed.BatchId}"
            });
            await db.SaveChangesAsync(cancellationToken);

            await context.LogInfoAsync($"Artifact created: {imageName} ({info.Length} bytes)", cancellationToken);
            await context.SetProgressPermilleAsync(1000, cancellationToken);
        }
        finally
        {
            try { Directory.Delete(workRoot, recursive: true); } catch { }
        }
    }

    private static async Task CreateFatImageAsync(BackgroundJobExecutionContext context, string contentDir, string imageAbs, CancellationToken cancellationToken)
    {
        var oneGiB = 1024L * 1024L * 1024L;
        await context.LogInfoAsync($"Creating 1GiB image: {imageAbs}", cancellationToken);

        await using (var fs = new FileStream(imageAbs, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
        {
            fs.SetLength(oneGiB);
        }

        // mkfs.fat and mcopy are required. Fail with a clear message if missing.
        await RunAsync(context, "mkfs.fat", $"-F 32 -n EVERDRIVE \"{imageAbs}\"", cancellationToken);
        await RunAsync(context, "mcopy", $"-i \"{imageAbs}\" -s \"{contentDir}\"/* ::/", cancellationToken, useShell: true);
    }

    private static async Task RunAsync(BackgroundJobExecutionContext context, string fileName, string args, CancellationToken cancellationToken, bool useShell = false)
    {
        var psi = useShell
            ? new ProcessStartInfo("/bin/bash", $"-lc \"{fileName} {args.Replace("\"", "\\\"")}\"")
            : new ProcessStartInfo(fileName, args);

        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.UseShellExecute = false;

        await context.LogInfoAsync($"Run: {psi.FileName} {psi.Arguments}", cancellationToken);

        using var proc = Process.Start(psi);
        if (proc is null)
        {
            throw new InvalidOperationException($"Failed to start process: {fileName}");
        }

        var stdout = await proc.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = await proc.StandardError.ReadToEndAsync(cancellationToken);
        await proc.WaitForExitAsync(cancellationToken);

        if (!string.IsNullOrWhiteSpace(stdout))
        {
            await context.LogInfoAsync(stdout.Trim(), cancellationToken);
        }
        if (!string.IsNullOrWhiteSpace(stderr))
        {
            await context.LogWarnAsync(stderr.Trim(), cancellationToken);
        }

        if (proc.ExitCode != 0)
        {
            throw new InvalidOperationException($"Command failed ({proc.ExitCode}): {fileName} {args}. Install 'dosfstools' and 'mtools' (mkfs.fat/mcopy) on the host.");
        }
    }
}
