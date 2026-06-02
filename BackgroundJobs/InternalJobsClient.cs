using games_vault.BackgroundJobs.Commands;
using games_vault.EverDrive;

namespace games_vault.BackgroundJobs;

public interface IInternalJobsClient
{
    Task<int> EnqueueLibretroSyncAsync(bool force = false, CancellationToken cancellationToken = default);
    Task<int> EnqueueRomImportAsync(IEnumerable<string> paths, bool createUnknownGames = false, string unknownSystemName = "Unknown", CancellationToken cancellationToken = default);
    Task<int> EnqueueUploadImportAsync(string stagingDirectory, CancellationToken cancellationToken = default);
    Task<int> EnqueueWebImportAsync(string url, string? fileName = null, CancellationToken cancellationToken = default);
    Task<int> EnqueueWebScanAsync(int webSourceId, Guid sessionId, string? query, CancellationToken cancellationToken = default);
    Task<int> EnqueueWebDownloadAsync(int webSourceId, string url, CancellationToken cancellationToken = default);
    Task<int> EnqueueLocalFolderScanAsync(int localFolderId, Guid sessionId, string? query, CancellationToken cancellationToken = default);
    Task<int> EnqueueLocalFolderCopyAsync(int localFolderId, string fullPath, CancellationToken cancellationToken = default);
    Task<int> EnqueueLocalFolderLinkAsync(int localFolderId, string fullPath, CancellationToken cancellationToken = default);
    Task<int> EnqueueNetworkShareScanAsync(int networkShareId, Guid sessionId, string? query, CancellationToken cancellationToken = default);
    Task<int> EnqueueNetworkShareCopyAsync(int networkShareId, string fullPath, CancellationToken cancellationToken = default);
    Task<int> EnqueueEverDriveGbImageAsync(int batchId, string firmwareUrl, string firmwareLabel, CancellationToken cancellationToken = default);
    Task<int> EnqueueEverDriveGbZipAsync(int batchId, string firmwareUrl, string firmwareLabel, CancellationToken cancellationToken = default);

    Task<int> EnqueueSystemFilesImportFromLocalFolderAsync(int localFolderId, string? query, bool overwrite, int maxFiles, bool onlyMissing = false, CancellationToken cancellationToken = default);
    Task<int> EnqueueSystemFilesImportFromNetworkShareAsync(int networkShareId, string? query, bool overwrite, int maxFiles, bool onlyMissing = false, CancellationToken cancellationToken = default);
}

public sealed class InternalJobsClient(IBackgroundJobClient jobs) : IInternalJobsClient
{
    public Task<int> EnqueueLibretroSyncAsync(bool force = false, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("libretro.sync", new SyncLibretroDatabasePayload(force), cancellationToken: cancellationToken);

    public Task<int> EnqueueRomImportAsync(IEnumerable<string> paths, bool createUnknownGames = false, string unknownSystemName = "Unknown", CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("rom.import", new ImportRomsFromLibretroDatabasePayload(paths.ToArray(), createUnknownGames, unknownSystemName), cancellationToken: cancellationToken);

    public Task<int> EnqueueUploadImportAsync(string stagingDirectory, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("upload.import", new ImportUploadStagingPayload(stagingDirectory), cancellationToken: cancellationToken);

    public Task<int> EnqueueWebImportAsync(string url, string? fileName = null, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("web.import", new WebImportPayload(url, fileName), cancellationToken: cancellationToken);

    public Task<int> EnqueueWebScanAsync(int webSourceId, Guid sessionId, string? query, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("web.scan", new ScanWebSourcePayload(webSourceId, sessionId, query), cancellationToken: cancellationToken);

    public Task<int> EnqueueWebDownloadAsync(int webSourceId, string url, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("web.download", new DownloadFromWebSourcePayload(webSourceId, url), cancellationToken: cancellationToken);

    public Task<int> EnqueueLocalFolderScanAsync(int localFolderId, Guid sessionId, string? query, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("local.scan", new ScanLocalFolderPayload(localFolderId, sessionId, query), cancellationToken: cancellationToken);

    public Task<int> EnqueueLocalFolderCopyAsync(int localFolderId, string fullPath, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("local.copy", new CopyFromLocalFolderPayload(localFolderId, fullPath), cancellationToken: cancellationToken);

    public Task<int> EnqueueLocalFolderLinkAsync(int localFolderId, string fullPath, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("local.link", new LinkFromLocalFolderPayload(localFolderId, fullPath), cancellationToken: cancellationToken);

    public Task<int> EnqueueNetworkShareScanAsync(int networkShareId, Guid sessionId, string? query, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("share.scan", new ScanNetworkSharePayload(networkShareId, sessionId, query), cancellationToken: cancellationToken);

    public Task<int> EnqueueNetworkShareCopyAsync(int networkShareId, string fullPath, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("share.copy", new CopyFromNetworkSharePayload(networkShareId, fullPath), cancellationToken: cancellationToken);

    public Task<int> EnqueueEverDriveGbImageAsync(int batchId, string firmwareUrl, string firmwareLabel, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("everdrivegb.image", new EverDriveGbExportPayload(batchId, firmwareUrl, firmwareLabel), cancellationToken: cancellationToken);

    public Task<int> EnqueueEverDriveGbZipAsync(int batchId, string firmwareUrl, string firmwareLabel, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("everdrivegb.zip", new EverDriveGbExportPayload(batchId, firmwareUrl, firmwareLabel), cancellationToken: cancellationToken);

    public Task<int> EnqueueSystemFilesImportFromLocalFolderAsync(int localFolderId, string? query, bool overwrite, int maxFiles, bool onlyMissing = false, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("systemfiles.local", new SystemFilesImportFromLocalFolderPayload(localFolderId, query, overwrite, maxFiles, onlyMissing), cancellationToken: cancellationToken);

    public Task<int> EnqueueSystemFilesImportFromNetworkShareAsync(int networkShareId, string? query, bool overwrite, int maxFiles, bool onlyMissing = false, CancellationToken cancellationToken = default) =>
        jobs.EnqueueAsync("systemfiles.share", new SystemFilesImportFromNetworkSharePayload(networkShareId, query, overwrite, maxFiles, onlyMissing), cancellationToken: cancellationToken);
}
