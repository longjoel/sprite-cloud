using System.IO.Compression;
using System.Text.Json;
using games_vault.Libretro;
using Microsoft.Extensions.Options;

namespace games_vault.BackgroundJobs.Commands;

public sealed record SyncLibretroDatabasePayload(bool Force = false);

[BackgroundJobCommand("libretro.sync")]
public sealed class SyncLibretroDatabaseCommand(
    IHttpClientFactory httpClientFactory,
    LibretroDatabaseStore store,
    IOptions<LibretroDatabaseOptions> options) : IBackgroundJobCommand
{
    private readonly LibretroDatabaseOptions _options = options.Value;

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, System.Text.Json.JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<SyncLibretroDatabasePayload>(JobJson.Options) ?? new SyncLibretroDatabasePayload();

        store.EnsureRootExists();

        if (!typed.Force &&
            Directory.Exists(store.GetDatDirectoryPath()) &&
            Directory.EnumerateFiles(store.GetDatDirectoryPath(), "*.dat", SearchOption.AllDirectories).Any())
        {
            context.Logger.LogInformation("Libretro database already present; skipping download (set Force=true to re-sync).");
            await context.SetProgressPermilleAsync(1000, cancellationToken);
            return;
        }

        var zipPath = Path.Combine(Path.GetTempPath(), $"libretro-database-{Guid.NewGuid():N}.zip");
        var extractPath = Path.Combine(Path.GetTempPath(), $"libretro-database-{Guid.NewGuid():N}");

        try
        {
            await context.SetProgressPermilleAsync(0, cancellationToken);

            var client = httpClientFactory.CreateClient();
            using (var response = await client.GetAsync(_options.ZipUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
            {
                response.EnsureSuccessStatusCode();
                await using var zipStream = await response.Content.ReadAsStreamAsync(cancellationToken);
                await using var fileStream = File.Create(zipPath);
                await zipStream.CopyToAsync(fileStream, cancellationToken);
            }

            await context.SetProgressPermilleAsync(250, cancellationToken);
            await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);

            Directory.CreateDirectory(extractPath);

            using (var archive = ZipFile.OpenRead(zipPath))
            {
                var entries = archive.Entries
                    .Where(e => !string.IsNullOrEmpty(e.FullName) && !e.FullName.EndsWith("/", StringComparison.Ordinal))
                    .ToList();

                var processed = 0;
                foreach (var entry in entries)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    // GitHub zips are rooted like "libretro-database-master/...".
                    var relative = StripFirstPathSegment(entry.FullName);
                    if (relative is null)
                    {
                        continue;
                    }

                    // Only keep what we need for matching/import. (dat/ and metadat/)
                    if (!relative.StartsWith("dat/", StringComparison.OrdinalIgnoreCase) &&
                        !relative.StartsWith("metadat/", StringComparison.OrdinalIgnoreCase))
                    {
                        processed++;
                        continue;
                    }

                    if (Path.IsPathRooted(relative) || relative.Contains("..", StringComparison.Ordinal))
                    {
                        processed++;
                        continue;
                    }

                    var destinationPath = Path.GetFullPath(Path.Combine(extractPath, relative));
                    if (!destinationPath.StartsWith(Path.GetFullPath(extractPath), StringComparison.Ordinal))
                    {
                        processed++;
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                    entry.ExtractToFile(destinationPath, overwrite: true);

                    processed++;
                    if (processed % 100 == 0)
                    {
                        var progress = 250 + (int)(700.0 * processed / Math.Max(1, entries.Count));
                        await context.SetProgressPermilleAsync(Math.Clamp(progress, 0, 950), cancellationToken);
                        await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
                    }
                }
            }

            // Replace old store atomically-ish: delete then move.
            if (Directory.Exists(store.RootPath))
            {
                // Preserve root, replace dat and metadat folders.
                ReplaceDirectory(Path.Combine(extractPath, "dat"), store.GetDatDirectoryPath());
                ReplaceDirectory(Path.Combine(extractPath, "metadat"), store.GetMetaDatDirectoryPath());
            }

            await context.SetProgressPermilleAsync(1000, cancellationToken);
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
        {
            return;
        }

        if (Directory.Exists(destinationPath))
        {
            Directory.Delete(destinationPath, recursive: true);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);

        try
        {
            Directory.Move(sourcePath, destinationPath);
        }
        catch (IOException)
        {
            // Cross-device moves (e.g. /tmp -> project dir) can fail with "Invalid cross-device link".
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
        {
            return null;
        }

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
