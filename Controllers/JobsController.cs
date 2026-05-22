using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using games_vault.Profiles;

namespace games_vault.Controllers;

public class JobsController(AppDbContext db, CurrentAccessService currentAccess) : Controller
{
    public async Task<IActionResult> Index(string? status = null, int page = 1, int pageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = QueryJobs(status);
        var totalCount = await query.CountAsync();

        var recent = await query
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync();

        return View(new JobsIndexViewModel
        {
            Jobs = recent,
            Status = NormalizeStatus(status),
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount
        });
    }

    [HttpGet]
    public async Task<IActionResult> Rows(string? status = null, int page = 1, int pageSize = 100)
    {
        if (!await currentAccess.IsAdminAsync(HttpContext.RequestAborted)) return StatusCode(StatusCodes.Status403Forbidden);
        Response.Headers.CacheControl = "no-store";
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var jobs = await QueryJobs(status)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync();
        return PartialView("_JobRows", jobs);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Retry(int id)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        var job = await db.BackgroundJobs.FindAsync(id);
        if (job is null)
        {
            return NotFound();
        }

        if (job.Status == BackgroundJobStatus.Running)
        {
            TempData["Message"] = "Job is currently running and cannot be re-queued.";
            return RedirectToAction(nameof(Details), new { id });
        }

        ResetForRetry(job);

        await db.SaveChangesAsync();

        TempData["Message"] = $"Re-queued job #{job.Id}.";
        return RedirectToAction(nameof(Details), new { id = job.Id });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ClearCompleted(string? status = null, int page = 1, int pageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        // "Completed" here means succeeded; failed jobs are usually kept for diagnosis unless explicitly deleted.
        var deleted = await db.BackgroundJobs
            .Where(x => x.Status == BackgroundJobStatus.Succeeded)
            .ExecuteDeleteAsync();

        TempData["Message"] = deleted == 0 ? "No completed jobs to clear." : $"Cleared {deleted} completed job(s).";
        return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> PauseSelected(int[] ids, string? status = null, int page = 1, int pageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        ids = (ids ?? Array.Empty<int>()).Where(x => x > 0).Distinct().ToArray();
        if (ids.Length == 0)
        {
            TempData["Message"] = "No jobs selected.";
            return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
        }

        var now = DateTime.UtcNow;
        var updated = await db.BackgroundJobs
            .Where(x => ids.Contains(x.Id) && (x.Status == BackgroundJobStatus.Queued || x.Status == BackgroundJobStatus.Running))
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(x => x.Status, BackgroundJobStatus.Paused)
                .SetProperty(x => x.LockedBy, (string?)null)
                .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                .SetProperty(x => x.UpdatedUtc, now));

        TempData["Message"] = updated == 0 ? "No selected jobs were paused." : $"Paused {updated} job(s).";
        return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CancelSelected(int[] ids, string? status = null, int page = 1, int pageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        ids = (ids ?? Array.Empty<int>()).Where(x => x > 0).Distinct().ToArray();
        if (ids.Length == 0)
        {
            TempData["Message"] = "No jobs selected.";
            return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
        }

        var now = DateTime.UtcNow;
        var updated = await db.BackgroundJobs
            .Where(x => ids.Contains(x.Id) && x.Status != BackgroundJobStatus.Succeeded)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(x => x.Status, BackgroundJobStatus.Canceled)
                .SetProperty(x => x.CompletedUtc, now)
                .SetProperty(x => x.LockedBy, (string?)null)
                .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                .SetProperty(x => x.UpdatedUtc, now)
                .SetProperty(x => x.LastError, "Canceled by user."));

        TempData["Message"] = updated == 0 ? "No selected jobs were canceled." : $"Canceled {updated} job(s).";
        return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteSelected(int[] ids, string? status = null, int page = 1, int pageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        ids = (ids ?? Array.Empty<int>()).Where(x => x > 0).Distinct().ToArray();
        if (ids.Length == 0)
        {
            TempData["Message"] = "No jobs selected.";
            return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
        }

        var deleted = await db.BackgroundJobs
            .Where(x => ids.Contains(x.Id) && x.Status != BackgroundJobStatus.Running)
            .ExecuteDeleteAsync();

        TempData["Message"] = deleted == 0 ? "No selected jobs were deleted (running jobs cannot be deleted)." : $"Deleted {deleted} job(s).";
        return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RerunSelected(int[] ids, string? status = null, int page = 1, int pageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        ids = (ids ?? Array.Empty<int>()).Where(x => x > 0).Distinct().ToArray();
        if (ids.Length == 0)
        {
            TempData["Message"] = "No jobs selected.";
            return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
        }

        var jobs = await db.BackgroundJobs
            .Where(x => ids.Contains(x.Id))
            .ToListAsync();

        var skippedRunning = 0;
        var reran = 0;

        foreach (var job in jobs)
        {
            if (job.Status == BackgroundJobStatus.Running)
            {
                skippedRunning++;
                continue;
            }

            ResetForRetry(job);
            reran++;
        }

        await db.SaveChangesAsync();

        if (reran == 0 && skippedRunning > 0)
        {
            TempData["Message"] = "Selected jobs are running and cannot be re-queued.";
        }
        else if (skippedRunning > 0)
        {
            TempData["Message"] = $"Re-queued {reran} job(s). Skipped {skippedRunning} running job(s).";
        }
        else
        {
            TempData["Message"] = $"Re-queued {reran} job(s).";
        }

        return RedirectToAction(nameof(Index), new { status = NormalizeStatus(status), page, pageSize });
    }

    public async Task<IActionResult> Details(int id, int logPage = 1, int logPageSize = 100)
    {
        if (await RequireAdminAsync() is { } denied) return denied;
        logPage = Math.Max(1, logPage);
        logPageSize = Math.Clamp(logPageSize, 10, 100);

        var job = await db.BackgroundJobs.FindAsync(id);
        if (job is null)
        {
            return NotFound();
        }

        var logQuery = db.BackgroundJobLogEntries
            .AsNoTracking()
            .Where(x => x.BackgroundJobId == job.Id);

        ViewData["JobLogTotalCount"] = await logQuery.CountAsync();
        ViewData["JobLogPage"] = logPage;
        ViewData["JobLogPageSize"] = logPageSize;
        ViewData["JobLogs"] = await logQuery
            .OrderByDescending(x => x.CreatedUtc)
            .Skip((logPage - 1) * logPageSize)
            .Take(logPageSize)
            .ToListAsync();

        if (job.Command == "share.scan")
        {
            var run = await db.NetworkScanRuns
                .Include(r => r.NetworkShare)
                .FirstOrDefaultAsync(r => r.BackgroundJobId == job.Id);

            if (run is not null)
            {
                ViewData["ScanRun"] = run;
                ViewData["ScanResultCount"] = await db.NetworkScanResults.CountAsync(r => r.NetworkScanRunId == run.Id);
            }
        }
        else if (job.Command == "web.scan")
        {
            var run = await db.WebScanRuns
                .Include(r => r.WebSource)
                .FirstOrDefaultAsync(r => r.BackgroundJobId == job.Id);

            if (run is not null)
            {
                ViewData["WebScanRun"] = run;
                ViewData["WebScanResultCount"] = await db.WebScanResults.CountAsync(r => r.WebScanRunId == run.Id);
            }
        }
        else if (job.Command == "local.scan")
        {
            var run = await db.LocalScanRuns
                .Include(r => r.LocalFolder)
                .FirstOrDefaultAsync(r => r.BackgroundJobId == job.Id);

            if (run is not null)
            {
                ViewData["LocalScanRun"] = run;
                ViewData["LocalScanResultCount"] = await db.LocalScanResults.CountAsync(r => r.LocalScanRunId == run.Id);
            }
        }
        else if (job.Command == "systemfiles.local" || job.Command == "systemfiles.share")
        {
            // For now, job logs are the main "history" for system file imports.
            ViewData["SystemFilesImport"] = true;
        }

        return View(job);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Pause(int id)
    {
        var now = DateTime.UtcNow;
        var updated = await db.BackgroundJobs
            .Where(x => x.Id == id && (x.Status == BackgroundJobStatus.Queued || x.Status == BackgroundJobStatus.Running))
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(x => x.Status, BackgroundJobStatus.Paused)
                .SetProperty(x => x.LockedBy, (string?)null)
                .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                .SetProperty(x => x.UpdatedUtc, now));

        TempData["Message"] = updated == 0 ? $"Job #{id} cannot be paused." : $"Paused job #{id}.";
        return RedirectToAction(nameof(Details), new { id });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Cancel(int id)
    {
        var now = DateTime.UtcNow;
        var updated = await db.BackgroundJobs
            .Where(x => x.Id == id && x.Status != BackgroundJobStatus.Succeeded)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(x => x.Status, BackgroundJobStatus.Canceled)
                .SetProperty(x => x.CompletedUtc, now)
                .SetProperty(x => x.LockedBy, (string?)null)
                .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                .SetProperty(x => x.UpdatedUtc, now)
                .SetProperty(x => x.LastError, "Canceled by user."));

        TempData["Message"] = updated == 0 ? $"Job #{id} cannot be canceled." : $"Canceled job #{id}.";
        return RedirectToAction(nameof(Details), new { id });
    }

    private static void ResetForRetry(BackgroundJob job)
    {
        job.Status = BackgroundJobStatus.Queued;
        job.Attempt = 0;
        job.ProgressPermille = null;
        job.LastError = null;
        job.LockedBy = null;
        job.LockedUntilUtc = null;
        job.StartedUtc = null;
        job.CompletedUtc = null;
        job.UpdatedUtc = DateTime.UtcNow;
    }

    private async Task<IActionResult?> RequireAdminAsync()
    {
        if (await currentAccess.IsAdminAsync(HttpContext.RequestAborted))
        {
            return null;
        }

        TempData["Message"] = "Admin profile required to access background jobs.";
        return RedirectToAction("Index", "Profiles");
    }

    private IQueryable<BackgroundJob> QueryJobs(string? status)
    {
        var q = db.BackgroundJobs.AsQueryable();

        if (TryParseStatus(status, out var st))
        {
            q = q.Where(x => x.Status == st);
        }

        return q.OrderByDescending(x => x.CreatedUtc);
    }

    private static bool TryParseStatus(string? status, out BackgroundJobStatus parsed)
    {
        parsed = default;
        if (string.IsNullOrWhiteSpace(status))
        {
            return false;
        }

        return Enum.TryParse(status.Trim(), ignoreCase: true, out parsed);
    }

    private static string? NormalizeStatus(string? status)
    {
        return TryParseStatus(status, out var st) ? st.ToString() : null;
    }
}
