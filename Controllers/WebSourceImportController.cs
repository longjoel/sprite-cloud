using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Libretro;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

public sealed class WebSourceImportController(
    AppDbContext db,
    IInternalJobsClient internalJobs,
    LibretroDatabaseStore libretroStore) : Controller
{
    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartScan(int webSourceId, Guid sessionId, string? q, CancellationToken cancellationToken)
    {
        if (!libretroStore.HasDatFiles())
        {
            TempData["Message"] = "Libretro database is not available yet. Start a libretro sync job first.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true });
        }

        if (sessionId == Guid.Empty)
        {
            sessionId = Guid.NewGuid();
        }

        var source = await db.WebSources.FirstOrDefaultAsync(s => s.Id == webSourceId, cancellationToken);
        if (source is null || !source.Enabled)
        {
            return BadRequest("Invalid web source.");
        }

        var jobId = await internalJobs.EnqueueWebScanAsync(webSourceId, sessionId, q, cancellationToken);

        db.WebScanRuns.Add(new games_vault.Models.WebScanRun
        {
            WebSourceId = webSourceId,
            BackgroundJobId = jobId,
            SessionId = sessionId,
            Status = games_vault.Models.WebScanStatus.Queued,
            CreatedUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);

        return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, webSessionId = sessionId, webSourceId, webQuery = q });
    }

    [HttpGet]
    public async Task<IActionResult> Results(Guid sessionId, int page = 1, int pageSize = 100, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var run = await db.WebScanRuns
            .Include(r => r.WebSource)
            .Include(r => r.BackgroundJob)
            .Where(r => r.SessionId == sessionId)
            .OrderByDescending(r => r.CreatedUtc)
            .FirstOrDefaultAsync(cancellationToken);

        if (run is null)
        {
            return Json(new { found = false });
        }

        var status = run.BackgroundJob.Status.ToString();

        var baseQuery = db.WebScanResults.Where(r => r.WebScanRunId == run.Id);
        var totalCount = await baseQuery.CountAsync(cancellationToken);
        var pageCount = pageSize <= 0 ? 0 : (int)Math.Ceiling(totalCount / (double)pageSize);
        page = Math.Min(page, Math.Max(1, pageCount));

        var results = await baseQuery
            .Where(r => r.WebScanRunId == run.Id)
            .OrderBy(r => r.FileName)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(r => new
            {
                r.Id,
                r.Url,
                r.FileName,
                r.SizeBytes,
                r.LastModifiedUtc
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
            webSourceId = run.WebSourceId,
            sourceName = run.WebSource.Name,
            results
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Import(int webSourceId, Guid sessionId, int[] resultIds, CancellationToken cancellationToken)
    {
        if (!libretroStore.HasDatFiles())
        {
            TempData["Message"] = "Libretro database is not available yet. Start a libretro sync job first.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, webSessionId = sessionId, webSourceId });
        }

        if (resultIds.Length == 0)
        {
            TempData["Message"] = "No files selected.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, webSessionId = sessionId, webSourceId });
        }

        var source = await db.WebSources.FirstOrDefaultAsync(s => s.Id == webSourceId, cancellationToken);
        if (source is null || !source.Enabled)
        {
            return BadRequest("Invalid web source.");
        }

        var results = await db.WebScanResults
            .Include(r => r.WebScanRun)
            .Where(r => resultIds.Contains(r.Id) && r.WebScanRun.SessionId == sessionId)
            .ToListAsync(cancellationToken);

        var enqueued = 0;
        foreach (var r in results)
        {
            await internalJobs.EnqueueWebDownloadAsync(webSourceId, r.Url, cancellationToken);
            enqueued++;
        }

        TempData["Message"] = $"Queued {enqueued} file import job(s).";
        return RedirectToAction(nameof(JobsController.Index), "Jobs");
    }
}
