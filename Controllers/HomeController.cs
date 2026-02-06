using System.Diagnostics;
using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models.ViewModels;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using games_vault.Models;

namespace games_vault.Controllers;

public class HomeController(
    AppDbContext db,
    LibretroDatabaseStore libretroStore,
    WebPlayerAssetLocator webPlayerLocator,
    IOptions<WebPlayerOptions> webPlayerOptions,
    SystemDatIndexProvider systemDat,
    SystemFileStorage systemFileStorage,
    IInternalJobsClient internalJobs) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        var latestLibretroSyncTask = db.BackgroundJobs
            .AsNoTracking()
            .Where(x => x.Command == "libretro.sync")
            .OrderByDescending(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);

        var latestWebPlayerInstallTask = db.BackgroundJobs
            .AsNoTracking()
            .Where(x => x.Command == "webplayer.install")
            .OrderByDescending(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);

        var gamesCountTask = db.Games.AsNoTracking().CountAsync(cancellationToken);
        var systemFilesCountTask = db.SystemFiles.AsNoTracking().CountAsync(cancellationToken);
        var networkSharesCountTask = db.NetworkShares.AsNoTracking().CountAsync(cancellationToken);
        var localFoldersCountTask = db.LocalFolders.AsNoTracking().CountAsync(cancellationToken);
        var webSourcesCountTask = db.WebSources.AsNoTracking().CountAsync(cancellationToken);

        await Task.WhenAll(
            latestLibretroSyncTask,
            latestWebPlayerInstallTask,
            gamesCountTask,
            systemFilesCountTask,
            networkSharesCountTask,
            localFoldersCountTask,
            webSourcesCountTask);

        var latestLibretroSync = await latestLibretroSyncTask;
        var latestWebPlayerInstall = await latestWebPlayerInstallTask;
        var gamesCount = await gamesCountTask;
        var systemFilesCount = await systemFilesCountTask;
        var networkSharesCount = await networkSharesCountTask;
        var localFoldersCount = await localFoldersCountTask;
        var webSourcesCount = await webSourcesCountTask;

        var libretroInstalled = libretroStore.HasDatFiles();
        int? missingSystemFilesCount = null;
        if (libretroInstalled)
        {
            var idx = systemDat.Get();
            missingSystemFilesCount = idx.ByPath.Values.Count(x => !System.IO.File.Exists(systemFileStorage.GetAbsoluteSystemPath(x.RelativePath)));
        }

        var webOpts = webPlayerOptions.Value ?? new WebPlayerOptions();

        return View(new HomeIndexViewModel
        {
            GamesCount = gamesCount,
            SystemFilesCount = systemFilesCount,
            MissingSystemFilesCount = missingSystemFilesCount,

            NetworkSharesCount = networkSharesCount,
            LocalFoldersCount = localFoldersCount,
            WebSourcesCount = webSourcesCount,

            LibretroDatabaseInstalled = libretroInstalled,
            WebPlayerEnabled = webOpts.Enabled,
            WebPlayerInstalled = webPlayerLocator.IsInstalled(),
            WebPlayerBasePath = webPlayerLocator.BasePath,
            LatestLibretroSyncJob = BackgroundJobSummary.From(latestLibretroSync),
            LatestWebPlayerInstallJob = BackgroundJobSummary.From(latestWebPlayerInstall)
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartLibretroSync(bool force = false, CancellationToken cancellationToken = default)
    {
        var jobId = await internalJobs.EnqueueLibretroSyncAsync(force, cancellationToken);
        TempData["Message"] = force ? $"Queued forced libretro sync job #{jobId}." : $"Queued libretro sync job #{jobId}.";
        return RedirectToAction("Details", "Jobs", new { id = jobId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartWebPlayerInstall(bool force = false, CancellationToken cancellationToken = default)
    {
        var jobId = await internalJobs.EnqueueWebPlayerInstallAsync(force, cancellationToken);
        TempData["Message"] = force ? $"Queued forced web player install job #{jobId}." : $"Queued web player install job #{jobId}.";
        return RedirectToAction("Details", "Jobs", new { id = jobId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartInstallAll(CancellationToken cancellationToken = default)
    {
        var libretroJobId = await internalJobs.EnqueueLibretroSyncAsync(force: false, cancellationToken);
        var webPlayerJobId = await internalJobs.EnqueueWebPlayerInstallAsync(force: false, cancellationToken);
        TempData["Message"] = $"Queued install jobs: libretro sync #{libretroJobId}, web player install #{webPlayerJobId}.";
        return RedirectToAction("Index", "Jobs");
    }

    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
    }
}
