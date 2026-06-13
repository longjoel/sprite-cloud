using System.Collections.Concurrent;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Libretro.Import;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.BackgroundJobs;

/// <summary>
/// Watches a configured folder for new/changed ROM files and enqueues
/// <c>rom.watch</c> import jobs. Handles startup reconciliation,
/// file-system event debouncing, and cleanup of unlinked files.
/// </summary>
public sealed class RomFolderWatcher : IHostedService, IDisposable
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<RomFolderWatcher> _logger;
    private readonly LibraryStorageOptions _options;

    private FileSystemWatcher? _watcher;
    private Timer? _debounceTimer;
    private readonly ConcurrentDictionary<string, byte> _pendingPaths = new(StringComparer.Ordinal);
    private readonly Lock _debounceLock = new();
    private bool _disposed;
    private bool _startupComplete;

    private const int MaxEnqueuePerBatch = 200;

    public RomFolderWatcher(
        IServiceScopeFactory scopeFactory,
        IOptions<LibraryStorageOptions> options,
        ILogger<RomFolderWatcher> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _options = options.Value;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var watch = _options.WatchFolder;
        if (watch is null || !watch.Enabled || string.IsNullOrWhiteSpace(watch.Path))
        {
            _logger.LogInformation("RomFolderWatcher: disabled (no watch folder configured).");
            return;
        }

        var watchPath = watch.Path;

        if (!Directory.Exists(watchPath))
        {
            _logger.LogWarning("RomFolderWatcher: watch path does not exist: {Path}. Creating...", watchPath);
            Directory.CreateDirectory(watchPath);
        }

        // --- startup reconcile ---
        await ReconcileOnStartupAsync(watchPath, cancellationToken);

        // --- FileSystemWatcher setup ---
        try
        {
            _watcher = new FileSystemWatcher(watchPath)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                EnableRaisingEvents = true
            };

            _watcher.Created += OnFileEvent;
            _watcher.Changed += OnFileEvent;
            _watcher.Renamed += OnFileEvent;
            _watcher.Deleted += OnDeleted;
            _watcher.Error += OnWatcherError;

            _logger.LogInformation(
                "RomFolderWatcher: watching {Path} (debounce={DebounceMs}ms, mode={Mode})",
                watchPath, watch.DebounceMs, watch.Mode);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RomFolderWatcher: failed to create FileSystemWatcher for {Path}", watchPath);
        }

        _startupComplete = true;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _debounceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
        if (_watcher is not null)
        {
            _watcher.EnableRaisingEvents = false;
        }

        return Task.CompletedTask;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _debounceTimer?.Dispose();
        _watcher?.Dispose();
    }

    // ── Startup reconcile ──────────────────────────────────────────────

    private async Task ReconcileOnStartupAsync(string watchPath, CancellationToken ct)
    {
        _logger.LogInformation("RomFolderWatcher: reconciling watch folder on startup...");

        string[] onDisk;
        try
        {
            onDisk = Directory.EnumerateFiles(watchPath, "*", SearchOption.TopDirectoryOnly)
                .Where(f => !f.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                .ToArray();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RomFolderWatcher: failed to enumerate {Path}", watchPath);
            return;
        }

        if (onDisk.Length == 0)
        {
            _logger.LogInformation("RomFolderWatcher: startup reconcile — no files found.");
            return;
        }

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Normalise paths to match what GameFile.ExternalPath stores
        var onDiskNormalized = onDisk.Select(p => Path.GetFullPath(p)).ToHashSet(StringComparer.Ordinal);

        // Find existing files linked to anywhere under the watch path
        var known = await db.GameFiles
            .Where(f => f.ExternalPath != null && f.ExternalPath.StartsWith(watchPath))
            .Select(f => f.ExternalPath!)
            .ToListAsync(ct);

        var knownNormalized = known
            .Select(p => Path.GetFullPath(p))
            .ToHashSet(StringComparer.Ordinal);

        // Files on disk but not in DB → enqueue for import
        var newFiles = onDiskNormalized
            .Where(p => !knownNormalized.Contains(p))
            .OrderBy(p => p) // deterministic order
            .ToArray();

        // Files in DB but missing from disk → unlink
        var missingFiles = knownNormalized
            .Where(p => !onDiskNormalized.Contains(p))
            .OrderBy(p => p)
            .ToArray();

        if (newFiles.Length > 0)
        {
            _logger.LogInformation(
                "RomFolderWatcher: startup reconcile — {Count} new file(s) to import.", newFiles.Length);
            await EnqueueImportAsync(newFiles, ct);
        }

        if (missingFiles.Length > 0)
        {
            _logger.LogInformation(
                "RomFolderWatcher: startup reconcile — {Count} file(s) disappeared.", missingFiles.Length);
            await ClearExternalPathsAsync(db, missingFiles, ct);
        }

        if (newFiles.Length == 0 && missingFiles.Length == 0)
        {
            _logger.LogInformation("RomFolderWatcher: startup reconcile — nothing to do ({Count} files in sync).", onDisk.Length);
        }
    }

    // ── File system events ─────────────────────────────────────────────

    private void OnFileEvent(object sender, FileSystemEventArgs e)
    {
        // Only handle standard ROM files
        if (string.IsNullOrWhiteSpace(e.Name) || e.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            return;

        _pendingPaths.TryAdd(e.FullPath, 0);
        ResetDebounce();
    }

    private void OnDeleted(object sender, FileSystemEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(e.Name))
            return;

        // Handle deletion synchronously: clear ExternalPath on the matching GameFile.
        // Use a separate short debounce so batch deletions coalesce into one DB update.
        _pendingPaths.TryAdd($"__DELETE__:{e.FullPath}", 0);
        ResetDebounce();
    }

    private void OnWatcherError(object sender, ErrorEventArgs e)
    {
        _logger.LogError(e.GetException(), "RomFolderWatcher: FileSystemWatcher error");
    }

    // ── Debounce ───────────────────────────────────────────────────────

    private void ResetDebounce()
    {
        lock (_debounceLock)
        {
            _debounceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
            _debounceTimer?.Change(_options.WatchFolder?.DebounceMs ?? 2000, Timeout.Infinite);
        }
    }

    // Called once per debounce tick (e.g. 2s after the last file event).
    private async void OnDebounceElapsed(object? state)
    {
        try
        {
            await FlushAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RomFolderWatcher: debounce flush failed");
        }
    }

    private async Task FlushAsync(CancellationToken ct)
    {
        // Atomically snapshot and clear pending
        string[] deleteKeys, importPaths;
        lock (_debounceLock)
        {
            deleteKeys = _pendingPaths.Keys.Where(k => k.StartsWith("__DELETE__:")).ToArray();
            importPaths = _pendingPaths.Keys.Where(k => !k.StartsWith("__DELETE__:")).OrderBy(p => p).ToArray();
            _pendingPaths.Clear();
        }

        // Handle deletions first
        if (deleteKeys.Length > 0)
        {
            var deletePaths = deleteKeys
                .Select(k => Path.GetFullPath(k["__DELETE__:".Length..]))
                .Distinct(StringComparer.Ordinal)
                .ToArray();

            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await ClearExternalPathsAsync(db, deletePaths, ct);
        }

        // Enqueue imports in batches
        if (importPaths.Length > 0)
        {
            var normalized = importPaths
                .Select(p => Path.GetFullPath(p))
                .Distinct(StringComparer.Ordinal)
                .ToArray();

            foreach (var batch in normalized.Chunk(MaxEnqueuePerBatch))
            {
                await EnqueueImportAsync(batch, ct);
            }
        }
    }

    // ── Import enqueue ─────────────────────────────────────────────────

    private async Task EnqueueImportAsync(string[] paths, CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IBackgroundJobClient>();

        try
        {
            var jobId = await client.EnqueueAsync(
                "rom.watch",
                new RomWatchImportPayload(paths, TotalEnqueued: paths.Length),
                maxAttempts: 2,
                cancellationToken: ct);

            _logger.LogInformation(
                "RomFolderWatcher: enqueued rom.watch job #{JobId} with {Count} file(s).", jobId, paths.Length);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RomFolderWatcher: failed to enqueue rom.watch job with {Count} file(s).", paths.Length);
        }
    }

    // ── External path cleanup ──────────────────────────────────────────

    private static async Task ClearExternalPathsAsync(AppDbContext db, string[] missingPaths, CancellationToken ct)
    {
        var normalized = missingPaths.Select(p => Path.GetFullPath(p)).ToHashSet(StringComparer.Ordinal);

        var toUnlink = await db.GameFiles
            .Where(f => f.ExternalPath != null)
            .ToListAsync(ct);

        var changed = 0;
        foreach (var gf in toUnlink)
        {
            if (gf.ExternalPath != null && normalized.Contains(Path.GetFullPath(gf.ExternalPath)))
            {
                gf.ExternalPath = null;
                changed++;
            }
        }

        if (changed > 0)
        {
            await db.SaveChangesAsync(ct);
        }
    }
}
