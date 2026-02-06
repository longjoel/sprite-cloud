using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

public class NetworkImportController(AppDbContext db, IInternalJobsClient internalJobs) : Controller
{
    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartScan(int networkShareId, Guid sessionId, string? q, CancellationToken cancellationToken)
    {
        if (sessionId == Guid.Empty)
        {
            sessionId = Guid.NewGuid();
        }

        var share = await db.NetworkShares.FirstOrDefaultAsync(s => s.Id == networkShareId, cancellationToken);
        if (share is null || !share.Enabled)
        {
            return BadRequest("Invalid network share.");
        }

        var jobId = await internalJobs.EnqueueNetworkShareScanAsync(networkShareId, sessionId, q, cancellationToken);

        db.NetworkScanRuns.Add(new NetworkScanRun
        {
            NetworkShareId = networkShareId,
            BackgroundJobId = jobId,
            SessionId = sessionId,
            Status = NetworkScanStatus.Queued,
            CreatedUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);

        return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, sessionId, networkShareId, networkQuery = q });
    }

    [HttpGet]
    public async Task<IActionResult> Results(Guid sessionId, int page = 1, int pageSize = 100, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var run = await db.NetworkScanRuns
            .Include(r => r.NetworkShare)
            .Include(r => r.BackgroundJob)
            .Where(r => r.SessionId == sessionId)
            .OrderByDescending(r => r.CreatedUtc)
            .FirstOrDefaultAsync(cancellationToken);

        if (run is null)
        {
            return Json(new { found = false });
        }

        // Mirror background job status for observability
        var status = run.BackgroundJob.Status.ToString();

        var baseQuery = db.NetworkScanResults.Where(r => r.NetworkScanRunId == run.Id);
        var totalCount = await baseQuery.CountAsync(cancellationToken);
        var pageCount = pageSize <= 0 ? 0 : (int)Math.Ceiling(totalCount / (double)pageSize);
        page = Math.Min(page, Math.Max(1, pageCount));

        var results = await baseQuery
            .Where(r => r.NetworkScanRunId == run.Id)
            .OrderByDescending(r => r.LastWriteUtc)
            .ThenBy(r => r.FileName)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(r => new
            {
                r.Id,
                r.FullPath,
                r.FileName,
                r.SizeBytes,
                r.LastWriteUtc
            })
            .ToListAsync(cancellationToken);

        return Json(new
        {
            found = true,
            runId = run.Id,
            jobId = run.BackgroundJobId,
            status,
            progressPermille = run.BackgroundJob.ProgressPermille,
            page,
            pageSize,
            totalCount,
            pageCount,
            networkShareId = run.NetworkShareId,
            shareName = run.NetworkShare.Name,
            results
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Import(int networkShareId, Guid sessionId, int[] resultIds, CancellationToken cancellationToken)
    {
        if (resultIds.Length == 0)
        {
            TempData["Message"] = "No files selected.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, sessionId, networkShareId });
        }

        var share = await db.NetworkShares.FirstOrDefaultAsync(s => s.Id == networkShareId, cancellationToken);
        if (share is null || !share.Enabled)
        {
            return BadRequest("Invalid network share.");
        }

        var results = await db.NetworkScanResults
            .Include(r => r.NetworkScanRun)
            .Where(r => resultIds.Contains(r.Id) && r.NetworkScanRun.SessionId == sessionId)
            .ToListAsync(cancellationToken);

        var enqueued = 0;
        foreach (var r in results)
        {
            await internalJobs.EnqueueNetworkShareCopyAsync(networkShareId, r.FullPath, cancellationToken);
            enqueued++;
        }

        TempData["Message"] = $"Queued {enqueued} file import job(s).";
        return RedirectToAction(nameof(JobsController.Index), "Jobs");
    }
}
