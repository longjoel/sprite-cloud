using System.Diagnostics;
using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
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
    IInternalJobsClient internalJobs,
    GamePlayTelemetryService gamePlayTelemetry,
    NosebleedSessionManager nosebleedSessions,
    NosebleedProcessInspector nosebleedProcessInspector) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        var latestLibretroSync = await db.BackgroundJobs
            .AsNoTracking()
            .Where(x => x.Command == "libretro.sync")
            .OrderByDescending(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);

        var latestWebPlayerInstall = await db.BackgroundJobs
            .AsNoTracking()
            .Where(x => x.Command == "webplayer.install")
            .OrderByDescending(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);

        var gamesCount = await db.Games.AsNoTracking().CountAsync(cancellationToken);
        var systemsCount = await db.Games.AsNoTracking().Select(x => x.SystemName).Distinct().CountAsync(cancellationToken);
        var gameFilesCount = await db.GameFiles.AsNoTracking().CountAsync(cancellationToken);
        var totalGameBytes = await db.GameFiles.AsNoTracking().SumAsync(x => (long?)x.SizeBytes, cancellationToken) ?? 0;
        var systemFilesCount = await db.SystemFiles.AsNoTracking().CountAsync(cancellationToken);
        var networkSharesCount = await db.NetworkShares.AsNoTracking().CountAsync(cancellationToken);
        var localFoldersCount = await db.LocalFolders.AsNoTracking().CountAsync(cancellationToken);
        var webSourcesCount = await db.WebSources.AsNoTracking().CountAsync(cancellationToken);

        nosebleedSessions.Cleanup();
        var activeSessions = nosebleedSessions.GetSessions();
        await gamePlayTelemetry.ReconcileActiveExternalSessionsAsync(
            "nosebleed",
            activeSessions.Select(x => x.SessionId).ToHashSet(StringComparer.OrdinalIgnoreCase),
            "process-exit",
            cancellationToken);

        var telemetryStats = await gamePlayTelemetry.GetDashboardStatsAsync(cancellationToken);
        var lastPlayedGame = await db.GamePlaySessions
            .AsNoTracking()
            .OrderByDescending(x => x.StartedUtc)
            .Select(x => x.Game.Name)
            .FirstOrDefaultAsync(cancellationToken);
        var playRows = await db.GamePlaySessions
            .AsNoTracking()
            .Select(x => new { x.GameId, GameName = x.Game.Name, x.StartedUtc, x.EndedUtc, x.DurationSeconds })
            .ToListAsync(cancellationToken);

        var now = DateTime.UtcNow;
        var topPlayedGames = playRows
            .GroupBy(x => new { x.GameId, x.GameName })
            .Select(g => new TopPlayedGameViewModel
            {
                GameId = g.Key.GameId,
                GameName = g.Key.GameName,
                SessionCount = g.Count(),
                TotalPlayTime = TimeSpan.FromSeconds(g.Sum(x => Math.Max(0, x.EndedUtc.HasValue
                    ? x.DurationSeconds
                    : (int)Math.Round((now - x.StartedUtc).TotalSeconds, MidpointRounding.AwayFromZero))))
            })
            .OrderByDescending(x => x.TotalPlayTime)
            .ThenByDescending(x => x.SessionCount)
            .ThenBy(x => x.GameName)
            .Take(5)
            .ToList();

        var managedPids = nosebleedSessions.GetManagedProcessIds();
        var orphanProcesses = nosebleedProcessInspector.GetOrphanProcesses(managedPids);
        var activeGameIds = activeSessions.Select(x => x.GameId).Distinct().ToArray();
        var activeGameNames = activeGameIds.Length == 0
            ? new Dictionary<int, string>()
            : await db.Games
                .AsNoTracking()
                .Where(x => activeGameIds.Contains(x.Id))
                .Select(x => new { x.Id, x.Name })
                .ToDictionaryAsync(x => x.Id, x => x.Name, cancellationToken);
        var activeSessionModels = activeSessions
            .Select(x => new ActiveNosebleedSessionViewModel
            {
                SessionId = x.SessionId,
                GameId = x.GameId,
                FileId = x.FileId,
                GameName = activeGameNames.TryGetValue(x.GameId, out var name) ? name : $"Game #{x.GameId}",
                Port = x.Port,
                BaseUrl = x.BaseUrl,
                StartedUtc = x.StartedUtc,
                Runtime = x.Runtime,
                CorePath = x.CorePath,
                ContentPath = x.ContentPath,
                ProcessId = x.ProcessId,
                HasExited = x.HasExited
            })
            .ToList();

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
            ShowDashboard = telemetryStats.TotalSessions > 0 || activeSessionModels.Count > 0 || gamesCount > 0,
            GamesCount = gamesCount,
            SystemsCount = systemsCount,
            GameFilesCount = gameFilesCount,
            TotalGameBytes = totalGameBytes,
            TotalPlayTime = TimeSpan.FromSeconds(telemetryStats.TotalDurationSeconds),
            PlaySessionCount = telemetryStats.TotalSessions,
            LastPlayedGame = lastPlayedGame,
            TopPlayedGames = topPlayedGames,
            ActiveNosebleedSessions = activeSessionModels,
            OrphanNosebleedProcesses = orphanProcesses,
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
    public async Task<IActionResult> StopNosebleedSession(string sessionId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            TempData["Message"] = "No Nosebleed session id was provided.";
            return RedirectToAction(nameof(Index));
        }

        var stopped = nosebleedSessions.TryStop(sessionId, "manual-stop");
        await gamePlayTelemetry.FinishByExternalSessionAsync(sessionId, "manual-stop", cancellationToken);
        TempData["Message"] = stopped
            ? $"Stopped Nosebleed session {sessionId}."
            : $"Nosebleed session {sessionId} was not found.";
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult KillNosebleedProcess(int pid)
    {
        if (nosebleedSessions.GetManagedProcessIds().Contains(pid))
        {
            TempData["Message"] = $"Process {pid} is a managed Nosebleed session. Use Stop session instead.";
            return RedirectToAction(nameof(Index));
        }

        var killed = nosebleedProcessInspector.TryKillIfNosebleed(pid);
        TempData["Message"] = killed
            ? $"Killed orphan Nosebleed process {pid}."
            : $"Process {pid} was not a live Nosebleed process or could not be killed.";
        return RedirectToAction(nameof(Index));
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
