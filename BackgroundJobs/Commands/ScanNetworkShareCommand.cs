using System.Text.Json;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using games_vault.NetworkShares;

namespace games_vault.BackgroundJobs.Commands;

public sealed record ScanNetworkSharePayload(int NetworkShareId, Guid SessionId, string? Query = null, int MaxResults = 2000);

[BackgroundJobCommand("share.scan")]
public sealed class ScanNetworkShareCommand(AppDbContext db, ISmbFileService smb) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<ScanNetworkSharePayload>(JobJson.Options);
        if (typed is null || typed.NetworkShareId <= 0)
        {
            throw new InvalidOperationException("share.scan payload must include a networkShareId.");
        }

        var share = await db.NetworkShares.FirstOrDefaultAsync(s => s.Id == typed.NetworkShareId, cancellationToken);
        if (share is null || !share.Enabled)
        {
            throw new InvalidOperationException("Network share not found or disabled.");
        }

        var run = await db.NetworkScanRuns.FirstOrDefaultAsync(
            r => r.BackgroundJobId == context.Job.Id,
            cancellationToken);

        if (run is null)
        {
            run = new NetworkScanRun
            {
                NetworkShareId = share.Id,
                BackgroundJobId = context.Job.Id,
                SessionId = typed.SessionId,
                Status = NetworkScanStatus.Running,
                CreatedUtc = DateTime.UtcNow
            };
            db.NetworkScanRuns.Add(run);
            await db.SaveChangesAsync(cancellationToken);
        }
        else
        {
            run.Status = NetworkScanStatus.Running;
            await db.SaveChangesAsync(cancellationToken);
        }

        // Clear previous results for this session so the page gets fresh data.
        var existing = await db.NetworkScanResults
            .Where(x => x.NetworkScanRun.SessionId == typed.SessionId)
            .ExecuteDeleteAsync(cancellationToken);

        context.Logger.LogInformation("share.scan started: share={ShareId} path={Path} cleared={Cleared}", share.Id, share.RootPath, existing);

        var root = share.RootPath;
        var q = string.IsNullOrWhiteSpace(typed.Query) ? null : typed.Query.Trim().ToLowerInvariant();
        var max = Math.Clamp(typed.MaxResults, 1, 50_000);

        var results = new List<NetworkScanResult>(capacity: Math.Min(max, 5000));
        var count = 0;

        try
        {
            if (SmbUri.IsSmbUri(root))
            {
                await context.LogInfoAsync($"Starting SMB scan for share '{share.Name}' ({share.RootPath}) query='{typed.Query ?? ""}'", cancellationToken);
                var smbResults = await smb.SearchAsync(
                    share,
                    typed.Query,
                    max,
                    msg => context.LogInfoAsync(msg, cancellationToken),
                    cancellationToken);

                foreach (var r in smbResults)
                {
                    results.Add(new NetworkScanResult
                    {
                        NetworkScanRunId = run.Id,
                        FullPath = r.SmbUri,
                        FileName = r.FileName.Length > 260 ? r.FileName[^260..] : r.FileName,
                        SizeBytes = r.SizeBytes,
                        LastWriteUtc = r.LastWriteUtc,
                        CreatedUtc = DateTime.UtcNow
                    });

                    count++;
                    if (results.Count >= 500)
                    {
                        db.NetworkScanResults.AddRange(results);
                        await db.SaveChangesAsync(cancellationToken);
                        results.Clear();
                        await context.SetProgressPermilleAsync(Math.Min(950, count * 1000 / Math.Max(1, smbResults.Count)), cancellationToken);
                        await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
                    }
                }

                await context.LogInfoAsync($"SMB scan results: {count} file(s) matched", cancellationToken);
            }
            else
            {
                if (!Directory.Exists(root))
                {
                    throw new InvalidOperationException($"Share path not found: {root}");
                }

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

                    results.Add(new NetworkScanResult
                    {
                        NetworkScanRunId = run.Id,
                        FullPath = filePath,
                        FileName = fileName.Length > 260 ? fileName[^260..] : fileName,
                        SizeBytes = info.Exists ? info.Length : 0,
                        LastWriteUtc = info.Exists ? info.LastWriteTimeUtc : null,
                        CreatedUtc = DateTime.UtcNow
                    });

                    count++;
                    if (results.Count >= 250)
                    {
                        db.NetworkScanResults.AddRange(results);
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
        }
        catch
        {
            run.Status = NetworkScanStatus.Failed;
            run.CompletedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(cancellationToken);
            throw;
        }

        if (results.Count > 0)
        {
            db.NetworkScanResults.AddRange(results);
            await db.SaveChangesAsync(cancellationToken);
        }

        run.FileCount = count;
        run.Status = NetworkScanStatus.Succeeded;
        run.CompletedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}
