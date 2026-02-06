using System.Text.Json;
using games_vault.Data;
using games_vault.Local;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record ScanLocalFolderPayload(int LocalFolderId, Guid SessionId, string? Query = null, int MaxResults = 2000);

[BackgroundJobCommand("local.scan")]
public sealed class ScanLocalFolderCommand(AppDbContext db) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<ScanLocalFolderPayload>(JobJson.Options);
        if (typed is null || typed.LocalFolderId <= 0)
        {
            throw new InvalidOperationException("local.scan payload must include a localFolderId.");
        }

        var folder = await db.LocalFolders.FirstOrDefaultAsync(f => f.Id == typed.LocalFolderId, cancellationToken);
        if (folder is null || !folder.Enabled)
        {
            throw new InvalidOperationException("Local folder not found or disabled.");
        }

        var run = await db.LocalScanRuns.FirstOrDefaultAsync(r => r.BackgroundJobId == context.Job.Id, cancellationToken);
        if (run is null)
        {
            run = new LocalScanRun
            {
                LocalFolderId = folder.Id,
                BackgroundJobId = context.Job.Id,
                SessionId = typed.SessionId,
                Status = LocalScanStatus.Running,
                CreatedUtc = DateTime.UtcNow
            };
            db.LocalScanRuns.Add(run);
            await db.SaveChangesAsync(cancellationToken);
        }
        else
        {
            run.Status = LocalScanStatus.Running;
            await db.SaveChangesAsync(cancellationToken);
        }

        var existing = await db.LocalScanResults
            .Where(x => x.LocalScanRun.SessionId == typed.SessionId)
            .ExecuteDeleteAsync(cancellationToken);

        context.Logger.LogInformation("local.scan started: folder={FolderId} path={Path} cleared={Cleared}", folder.Id, folder.RootPath, existing);

        var root = LocalPathGuard.NormalizeRoot(folder.RootPath);
        if (!Directory.Exists(root))
        {
            throw new InvalidOperationException($"Folder not found: {root}");
        }

        var q = string.IsNullOrWhiteSpace(typed.Query) ? null : typed.Query.Trim().ToLowerInvariant();
        var max = Math.Clamp(typed.MaxResults, 1, 50_000);

        var results = new List<LocalScanResult>(capacity: Math.Min(max, 5000));
        var count = 0;

        try
        {
            await context.LogInfoAsync($"Starting local folder scan for '{folder.Name}' ({folder.RootPath}) query='{typed.Query ?? ""}'", cancellationToken);

            foreach (var filePath in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                cancellationToken.ThrowIfCancellationRequested();

                var fileName = Path.GetFileName(filePath);
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    continue;
                }

                if (q is not null && !fileName.ToLowerInvariant().Contains(q))
                {
                    continue;
                }

                FileInfo info;
                try { info = new FileInfo(filePath); } catch { continue; }

                if (filePath.Length > 1000)
                {
                    continue;
                }

                results.Add(new LocalScanResult
                {
                    LocalScanRunId = run.Id,
                    FullPath = filePath,
                    FileName = fileName.Length > 260 ? fileName[^260..] : fileName,
                    SizeBytes = info.Exists ? info.Length : 0,
                    LastWriteUtc = info.Exists ? info.LastWriteTimeUtc : null,
                    CreatedUtc = DateTime.UtcNow
                });

                count++;
                if (results.Count >= 250)
                {
                    db.LocalScanResults.AddRange(results);
                    await db.SaveChangesAsync(cancellationToken);
                    results.Clear();
                    await context.SetProgressPermilleAsync(Math.Min(950, count * 1000 / max), cancellationToken);
                    await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
                }

                if (count >= max)
                {
                    break;
                }
            }
        }
        catch
        {
            run.Status = LocalScanStatus.Failed;
            run.CompletedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(cancellationToken);
            throw;
        }

        if (results.Count > 0)
        {
            db.LocalScanResults.AddRange(results);
            await db.SaveChangesAsync(cancellationToken);
        }

        run.FileCount = count;
        run.Status = LocalScanStatus.Succeeded;
        run.CompletedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}
