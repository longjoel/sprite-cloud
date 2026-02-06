using games_vault.BackgroundJobs;
using games_vault.Libretro;
using Microsoft.AspNetCore.Mvc;

namespace games_vault.Controllers;

public sealed class WebImportController(
    IInternalJobsClient internalJobs,
    LibretroDatabaseStore libretroStore) : Controller
{
    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Import(string url, string? fileName, CancellationToken cancellationToken)
    {
        if (!libretroStore.HasDatFiles())
        {
            TempData["Message"] = "Libretro database is not available yet. Start a libretro sync job first.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true });
        }

        url = (url ?? "").Trim();
        fileName = string.IsNullOrWhiteSpace(fileName) ? null : fileName.Trim();

        if (string.IsNullOrWhiteSpace(url))
        {
            TempData["Message"] = "URL is required.";
            return RedirectToAction(nameof(GamesController.Index), "Games", new { openAdd = true });
        }

        var jobId = await internalJobs.EnqueueWebImportAsync(url, fileName, cancellationToken);
        TempData["Message"] = $"Queued web import job #{jobId}.";
        return RedirectToAction(nameof(JobsController.Details), "Jobs", new { id = jobId });
    }
}
