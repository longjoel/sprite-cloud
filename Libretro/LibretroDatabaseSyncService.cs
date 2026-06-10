using System.IO.Compression;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace games_vault.Libretro;

public sealed class LibretroDatabaseSyncService(
    IHttpClientFactory httpClientFactory,
    LibretroDatabaseStore store,
    IOptions<LibretroDatabaseOptions> options,
    ILogger<LibretroDatabaseSyncService> logger)
{
    private readonly LibretroDatabaseOptions _options = options.Value;

    public async Task SyncAsync(bool force = false, CancellationToken cancellationToken = default)
    {
        store.EnsureRootExists();

        if (!force &&
            Directory.Exists(store.GetDatDirectoryPath()) &&
            Directory.EnumerateFiles(store.GetDatDirectoryPath(), "*.dat", SearchOption.AllDirectories).Any())
        {
            logger.LogInformation("Libretro database already present; skipping download (set Force=true to re-sync).");
            return;
        }

        var zipPath = Path.Combine(Path.GetTempPath(), $"libretro-database-{Guid.NewGuid():N}.zip");
        var extractPath = Path.Combine(Path.GetTempPath(), $"libretro-database-{Guid.NewGuid():N}");

        try
        {
            var client = httpClientFactory.CreateClient();
            using (var response = await client.GetAsync(_options.ZipUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
            {
                response.EnsureSuccessStatusCode();
                await using var zipStream = await response.Content.ReadAsStreamAsync(cancellationToken);
                await using var fileStream = File.Create(zipPath);
                await zipStream.CopyToAsync(fileStream, cancellationToken);
            }

            Directory.CreateDirectory(extractPath);

            using (var archive = ZipFile.OpenRead(zipPath))
            {
                var entries = archive.Entries
                    .Where(e => !string.IsNullOrEmpty(e.FullName) && !e.FullName.EndsWith("/", StringComparison.Ordinal))
                    .ToList();

                foreach (var entry in entries)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var relative = StripFirstPathSegment(entry.FullName);
                    if (relative is null)
                        continue;

                    if (!relative.StartsWith("dat/", StringComparison.OrdinalIgnoreCase) &&
                        !relative.StartsWith("metadat/", StringComparison.OrdinalIgnoreCase))
                        continue;

                    if (Path.IsPathRooted(relative) || relative.Contains("..", StringComparison.Ordinal))
                        continue;

                    var destinationPath = Path.GetFullPath(Path.Combine(extractPath, relative));
                    if (!destinationPath.StartsWith(Path.GetFullPath(extractPath), StringComparison.Ordinal))
                        continue;

                    Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                    entry.ExtractToFile(destinationPath, overwrite: true);
                }
            }

            // Replace old store atomically-ish: delete then move.
            if (Directory.Exists(store.RootPath))
            {
                ReplaceDirectory(Path.Combine(extractPath, "dat"), store.GetDatDirectoryPath());
                ReplaceDirectory(Path.Combine(extractPath, "metadat"), store.GetMetaDatDirectoryPath());
            }

            logger.LogInformation("Libretro database sync complete.");
        }
        finally
        {
            TryDeleteFile(zipPath);
            TryDeleteDirectory(extractPath);
        }
    }

    private static void ReplaceDirectory(string sourcePath, string destinationPath)
    {
        if (!Directory.Exists(sourcePath))
            return;

        if (Directory.Exists(destinationPath))
            Directory.Delete(destinationPath, recursive: true);

        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);

        try
        {
            Directory.Move(sourcePath, destinationPath);
        }
        catch (IOException)
        {
            CopyDirectory(sourcePath, destinationPath);
            Directory.Delete(sourcePath, recursive: true);
        }
    }

    private static void CopyDirectory(string sourcePath, string destinationPath)
    {
        Directory.CreateDirectory(destinationPath);

        foreach (var dir in Directory.EnumerateDirectories(sourcePath, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourcePath, dir);
            Directory.CreateDirectory(Path.Combine(destinationPath, rel));
        }

        foreach (var file in Directory.EnumerateFiles(sourcePath, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourcePath, file);
            var destFile = Path.Combine(destinationPath, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(destFile)!);
            File.Copy(file, destFile, overwrite: true);
        }
    }

    private static string? StripFirstPathSegment(string path)
    {
        var idx = path.IndexOf('/', StringComparison.Ordinal);
        if (idx < 0 || idx == path.Length - 1)
            return null;
        return path[(idx + 1)..];
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); } catch { }
    }
}
