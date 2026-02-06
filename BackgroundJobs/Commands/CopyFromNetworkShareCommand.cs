using System.Text.Json;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.NetworkShares;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record CopyFromNetworkSharePayload(int NetworkShareId, string FullPath);

[BackgroundJobCommand("share.copy")]
public sealed class CopyFromNetworkShareCommand(
    AppDbContext db,
    UploadStagingStore stagingStore,
    IInternalJobsClient internalJobs,
    ISmbFileService smb) : IBackgroundJobCommand
{
    private sealed class InlineProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<CopyFromNetworkSharePayload>(JobJson.Options);
        if (typed is null || typed.NetworkShareId <= 0 || string.IsNullOrWhiteSpace(typed.FullPath))
        {
            throw new InvalidOperationException("share.copy payload must include a networkShareId and fullPath.");
        }

        var share = await db.NetworkShares.FirstOrDefaultAsync(s => s.Id == typed.NetworkShareId, cancellationToken);
        if (share is null || !share.Enabled)
        {
            throw new InvalidOperationException("Network share not found or disabled.");
        }

        var fullPath = typed.FullPath.Trim();

        var stagingDir = stagingStore.CreateStagingDirectory();
        var destPath = Path.Combine(stagingDir, Path.GetFileName(fullPath));

        await context.SetProgressPermilleAsync(0, cancellationToken);

        if (SmbUri.IsSmbUri(share.RootPath))
        {
            await context.LogInfoAsync($"Starting SMB copy: {fullPath}", cancellationToken);
            var lastWriteUtc = DateTime.MinValue;
            var lastP = -1;
            var progress = new InlineProgress<int>(p =>
            {
                // Throttle progress writes to avoid hammering SQLite + SaveChanges, and keep it single-threaded.
                if (p == lastP)
                {
                    return;
                }

                var now = DateTime.UtcNow;
                if (p < 1000 && lastWriteUtc != DateTime.MinValue && (now - lastWriteUtc) < TimeSpan.FromMilliseconds(250))
                {
                    lastP = p; // keep latest, but skip DB write
                    return;
                }

                lastP = p;
                lastWriteUtc = now;
                context.SetProgressPermilleAsync(p, cancellationToken).GetAwaiter().GetResult();
            });
            await smb.CopyFileToAsync(
                share,
                fullPath,
                destPath,
                progressPermille: progress,
                log: msg => context.LogInfoAsync(msg, cancellationToken),
                cancellationToken: cancellationToken);
        }
        else
        {
            if (!fullPath.StartsWith(share.RootPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
                !string.Equals(fullPath, share.RootPath, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("File path is not within the configured share root.");
            }

            if (!File.Exists(fullPath))
            {
                throw new InvalidOperationException("Source file not found.");
            }

            await using var src = File.OpenRead(fullPath);
            await using var dst = File.Create(destPath);
            await src.CopyToAsync(dst, cancellationToken);
        }

        await context.SetProgressPermilleAsync(800, cancellationToken);

        var importJobId = await internalJobs.EnqueueUploadImportAsync(stagingDir, cancellationToken);
        context.Logger.LogInformation("share.copy enqueued upload.import job {ImportJobId} for {Dest}", importJobId, destPath);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}
