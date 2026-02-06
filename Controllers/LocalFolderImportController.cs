using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Libretro;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

public sealed class LocalFolderImportController(
    AppDbContext db,
    IInternalJobsClient internalJobs,
    LibretroDatabaseStore libretroStore) : Controller
{
    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartScan(int localFolderId, Guid sessionId, string? q, CancellationToken cancellationToken)
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

        var folder = await db.LocalFolders.FirstOrDefaultAsync(f => f.Id == localFolderId, cancellationToken);
        if (folder is null || !folder.Enabled)
        {
            return BadRequest("Invalid local folder.");
        }

        var jobId = await internalJobs.EnqueueLocalFolderScanAsync(localFolderId, sessionId, q, cancellationToken);

        db.LocalScanRuns.Add(new games_vault.Models.LocalScanRun
        {
            LocalFolderId = localFolderId,
            BackgroundJobId = jobId,
            SessionId = sessionId,
            Status = games_vault.Models.LocalScanStatus.Queued,
            CreatedUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);

        return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, localSessionId = sessionId, localFolderId, localQuery = q });
    }

    [HttpGet]
    public async Task<IActionResult> Results(Guid sessionId, int page = 1, int pageSize = 100, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var run = await db.LocalScanRuns
            .Include(r => r.LocalFolder)
            .Include(r => r.BackgroundJob)
            .Where(r => r.SessionId == sessionId)
            .OrderByDescending(r => r.CreatedUtc)
            .FirstOrDefaultAsync(cancellationToken);

        if (run is null)
        {
            return Json(new { found = false });
        }

        var status = run.BackgroundJob.Status.ToString();

        var baseQuery = db.LocalScanResults.Where(r => r.LocalScanRunId == run.Id);
        var totalCount = await baseQuery.CountAsync(cancellationToken);
        var pageCount = pageSize <= 0 ? 0 : (int)Math.Ceiling(totalCount / (double)pageSize);
        page = Math.Min(page, Math.Max(1, pageCount));

        var results = await baseQuery
            .Where(r => r.LocalScanRunId == run.Id)
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
            localFolderId = run.LocalFolderId,
            folderName = run.LocalFolder.Name,
            results
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Import(int localFolderId, Guid sessionId, int[] resultIds, string mode, CancellationToken cancellationToken)
    {
        if (!libretroStore.HasDatFiles())
        {
            TempData["Message"] = "Libretro database is not available yet. Start a libretro sync job first.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, localSessionId = sessionId, localFolderId });
        }

        if (resultIds.Length == 0)
        {
            TempData["Message"] = "No files selected.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true, localSessionId = sessionId, localFolderId });
        }

        var folder = await db.LocalFolders.FirstOrDefaultAsync(f => f.Id == localFolderId, cancellationToken);
        if (folder is null || !folder.Enabled)
        {
            return BadRequest("Invalid local folder.");
        }

        var results = await db.LocalScanResults
            .Include(r => r.LocalScanRun)
            .Where(r => resultIds.Contains(r.Id) && r.LocalScanRun.SessionId == sessionId)
            .ToListAsync(cancellationToken);

        var linkRequested = string.Equals(mode, "link", StringComparison.OrdinalIgnoreCase);
        var enqueued = 0;
        var forcedCopy = 0;

        foreach (var r in results)
        {
            // Zip linking isn't supported; fall back to copy for those.
            var isZip = r.FileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);
            if (linkRequested && !isZip)
            {
                await internalJobs.EnqueueLocalFolderLinkAsync(localFolderId, r.FullPath, cancellationToken);
            }
            else
            {
                if (linkRequested && isZip)
                {
                    forcedCopy++;
                }

                await internalJobs.EnqueueLocalFolderCopyAsync(localFolderId, r.FullPath, cancellationToken);
            }

            enqueued++;
        }

        TempData["Message"] = forcedCopy > 0
            ? $"Queued {enqueued} file import job(s). Note: {forcedCopy} .zip file(s) were copied (zip linking isn't supported)."
            : $"Queued {enqueued} file import job(s).";

        return RedirectToAction(nameof(JobsController.Index), "Jobs");
    }
}
