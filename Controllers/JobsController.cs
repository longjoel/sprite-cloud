using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

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
        return PartialView("_JobRows", (IReadOnlyList<BackgroundJob>)jobs);
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
        ids = (ids ?? []).Where(x => x > 0).Distinct().ToArray();
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
        ids = (ids ?? []).Where(x => x > 0).Distinct().ToArray();
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
        ids = (ids ?? []).Where(x => x > 0).Distinct().ToArray();
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
        ids = (ids ?? []).Where(x => x > 0).Distinct().ToArray();
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
