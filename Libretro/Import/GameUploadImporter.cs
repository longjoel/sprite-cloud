using System.IO.Compression;
using games_vault.Data;
using games_vault.Libretro.Dat;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using games_vault.BackgroundJobs;

namespace games_vault.Libretro.Import;

public sealed class GameUploadImporter(
    AppDbContext db,
    UploadFileScanner scanner,
    LibretroDatIndexBuilder indexBuilder,
    GameFileStorage storage,
    ILogger<GameUploadImporter> logger)
{
    public sealed record ImportGroupResult(int GameId, string SystemName, string GameName, int MatchedFileCount);

    public sealed record ImportResult(
        int TotalScannedFileCount,
        int TotalMatchedFileCount,
        IReadOnlyList<ImportGroupResult> Groups);

    public async Task<ImportResult> ImportAsync(
        IEnumerable<IFormFile> uploads,
        CancellationToken cancellationToken)
    {
        var scanned = await scanner.ScanAsync(uploads, cancellationToken);
        return await ImportScannedAsync(scanned, cancellationToken);
    }

    public async Task<ImportResult> ImportFromStagedDirectoryAsync(
        string stagingDirectory,
        BackgroundJobs.BackgroundJobExecutionContext jobContext,
        CancellationToken cancellationToken)
    {
        if (!Directory.Exists(stagingDirectory))
        {
            throw new InvalidOperationException("Upload staging directory not found.");
        }

        var paths = Directory.EnumerateFiles(stagingDirectory, "*", SearchOption.TopDirectoryOnly).ToArray();
        await jobContext.SetProgressPermilleAsync(50, cancellationToken);

        var scanned = await scanner.ScanPathsAsync(paths, cancellationToken);
        await jobContext.SetProgressPermilleAsync(500, cancellationToken);

        var result = await ImportScannedFromStagingAsync(stagingDirectory, jobContext, scanned, cancellationToken);
        await jobContext.SetProgressPermilleAsync(950, cancellationToken);

        return result;
    }

    private async Task<ImportResult> ImportScannedFromStagingAsync(
        string stagingDirectory,
        BackgroundJobs.BackgroundJobExecutionContext jobContext,
        List<ScannedUploadFile> scanned,
        CancellationToken cancellationToken)
    {
        if (scanned.Count == 0)
        {
            throw new InvalidOperationException("No files were uploaded.");
        }

        var index = indexBuilder.BuildFromDisk();
        if (index.ByCrc32.Count == 0)
        {
            throw new InvalidOperationException("Libretro database isn't available yet. Run the libretro sync job first.");
        }

        var matched = scanned
            .Select(f => (File: f, Match: index.TryGetByCrc32(f.Crc32, out var entry) ? entry : null))
            .Where(x => x.Match is not null)
            .Select(x => (x.File, Match: x.Match!))
            .ToList();

        if (matched.Count == 0)
        {
            throw new InvalidOperationException("No uploaded files matched libretro-database (.dat) CRC32 entries.");
        }

        // We store bytes for matched files in the library before writing metadata.
        var storedByCrc = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (file, match) in matched)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (storedByCrc.ContainsKey(file.Crc32))
            {
                continue;
            }

            await jobContext.LogInfoAsync($"Storing ROM bytes for {file.DisplayName} ({match.SystemName}) CRC={file.Crc32}", cancellationToken);

            string storagePath;
            try
            {
                storagePath = await storage.StoreAsync(
                    openStream: () => OpenStagedFileStream(stagingDirectory, file.DisplayName),
                    displayName: file.DisplayName,
                    systemName: match.SystemName,
                    crc32: file.Crc32,
                    sizeBytes: file.SizeBytes,
                    cancellationToken: cancellationToken);
            }
            catch (Exception ex)
            {
                await jobContext.LogErrorAsync($"Failed to store ROM bytes for {file.DisplayName}: {ex.Message}", cancellationToken);
                throw;
            }

            storedByCrc[file.Crc32] = storagePath;
        }

        // Proceed with metadata import, attaching StoragePath to created GameFiles.
        return await ImportScannedAsync(
            scanned,
            cancellationToken,
            resolveStoragePath: crc32 => storedByCrc.TryGetValue(crc32, out var p) ? p : null);
    }

    public async Task<ImportResult> ImportLinkedLocalFilesAsync(IEnumerable<string> fullPaths, CancellationToken cancellationToken)
    {
        var list = (fullPaths ?? Array.Empty<string>())
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (list.Count == 0)
        {
            throw new InvalidOperationException("No files were provided.");
        }

        var scanned = new List<ScannedUploadFile>(capacity: list.Count);
        var externalByCrc = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var path in list)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!File.Exists(path))
            {
                continue;
            }

            var info = new FileInfo(path);
            if (!info.Exists || info.Length <= 0)
            {
                continue;
            }

            // Linking zip contents isn't supported; import those via copy/staging instead.
            if (info.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            await using var stream = File.OpenRead(path);
            var crc = await games_vault.Libretro.Crc32.ComputeAsync(stream, cancellationToken);
            var crc32 = crc.ToString("X8");

            if (!externalByCrc.ContainsKey(crc32))
            {
                externalByCrc[crc32] = path;
            }

            scanned.Add(new ScannedUploadFile(
                DisplayName: info.Name,
                SizeBytes: info.Length,
                Crc32: crc32));
        }

        if (scanned.Count == 0)
        {
            throw new InvalidOperationException("No eligible files were found (note: .zip files cannot be linked).");
        }

        return await ImportScannedAsync(
            scanned,
            cancellationToken,
            resolveExternalPath: crc32 => externalByCrc.TryGetValue(crc32, out var p) ? p : null);
    }

    private async Task<ImportResult> ImportScannedAsync(
        List<ScannedUploadFile> scanned,
        CancellationToken cancellationToken,
        Func<string, string?>? resolveStoragePath = null,
        Func<string, string?>? resolveExternalPath = null)
    {
        if (scanned.Count == 0)
        {
            throw new InvalidOperationException("No files were uploaded.");
        }

        var index = indexBuilder.BuildFromDisk();
        if (index.ByCrc32.Count == 0)
        {
            throw new InvalidOperationException("Libretro database isn't available yet. Run the libretro sync job first.");
        }

        var matched = scanned
            .Select(f => (File: f, Match: index.TryGetByCrc32(f.Crc32, out var entry) ? entry : null))
            .Where(x => x.Match is not null)
            .Select(x => (x.File, Match: x.Match!))
            .ToList();

        if (matched.Count == 0)
        {
            throw new InvalidOperationException("No uploaded files matched libretro-database (.dat) CRC32 entries.");
        }

        var groups = matched
            .GroupBy(x => (x.Match.SystemName, x.Match.GameName))
            .Select(g => new
            {
                g.Key.SystemName,
                g.Key.GameName,
                Items = g.ToList(),
                Count = g.Count(),
                TotalBytes = g.Sum(x => x.File.SizeBytes)
            })
            .OrderByDescending(x => x.Count)
            .ThenByDescending(x => x.TotalBytes)
            .ToList();

        var results = new List<ImportGroupResult>();

        foreach (var group in groups)
        {
            cancellationToken.ThrowIfCancellationRequested();

            logger.LogInformation(
                "Upload matched libretro game {System}/{Game} with {Matched} file(s)",
                group.SystemName, group.GameName, group.Count);

            var game = await db.Games.FirstOrDefaultAsync(
                g => g.SystemName == group.SystemName && g.Name == group.GameName,
                cancellationToken);

            if (game is null)
            {
                game = new Game
                {
                    SystemName = group.SystemName,
                    Name = group.GameName,
                    Crc32 = group.Count == 1 ? group.Items[0].File.Crc32 : null,
                    SizeBytes = group.TotalBytes,
                    CreatedUtc = DateTime.UtcNow
                };

                db.Games.Add(game);
                await db.SaveChangesAsync(cancellationToken);
            }
            else
            {
                // Keep the aggregate up to date when importing additional files for an existing game.
                game.Crc32 = group.Count == 1 ? group.Items[0].File.Crc32 : null;
                game.SizeBytes = group.TotalBytes;
                await db.SaveChangesAsync(cancellationToken);
            }

            foreach (var item in group.Items)
            {
                var name = item.File.DisplayName;
                if (name.Length > 260)
                {
                    name = name[^260..];
                }

                var exists = await db.GameFiles.AnyAsync(
                    f => f.GameId == game.Id && f.Name == name && f.Crc32 == item.File.Crc32,
                    cancellationToken);

                if (exists)
                {
                    continue;
                }

                db.GameFiles.Add(new GameFile
                {
                    GameId = game.Id,
                    Name = name,
                    OriginalFileName = GetOriginalFileName(item.File.DisplayName),
                    Crc32 = item.File.Crc32,
                    SizeBytes = item.File.SizeBytes,
                    StoragePath = resolveStoragePath?.Invoke(item.File.Crc32),
                    ExternalPath = resolveExternalPath?.Invoke(item.File.Crc32)
                });
            }

            await db.SaveChangesAsync(cancellationToken);
            results.Add(new ImportGroupResult(game.Id, group.SystemName, group.GameName, group.Count));
        }

        return new ImportResult(scanned.Count, matched.Count, results);
    }

    private static Stream OpenStagedFileStream(string stagingDirectory, string displayName)
    {
        // displayName can be:
        // - "file.gb"
        // - "outer.zip:rom.gb"
        // - "outer.zip:inner.zip:rom.gb"
        var parts = displayName.Split(':', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
        {
            throw new InvalidOperationException("Invalid display name.");
        }

        var outer = parts[0];
        var outerPath = Path.Combine(stagingDirectory, outer);
        if (!File.Exists(outerPath))
        {
            throw new InvalidOperationException($"Staged file not found: {outer}");
        }

        if (parts.Length == 1)
        {
            return File.OpenRead(outerPath);
        }

        // Walk zip chain, extracting the final payload into a MemoryStream.
        Stream current = File.OpenRead(outerPath);
        try
        {
            for (var i = 1; i < parts.Length; i++)
            {
                using var archive = new ZipArchive(current, ZipArchiveMode.Read, leaveOpen: false);
                var entryName = parts[i];
                var entry = archive.GetEntry(entryName);
                if (entry is null)
                {
                    // Some display names use FullName; try by exact FullName match.
                    entry = archive.Entries.FirstOrDefault(e => string.Equals(e.FullName, entryName, StringComparison.Ordinal));
                }
                if (entry is null)
                {
                    throw new InvalidOperationException($"Zip entry not found: {entryName}");
                }

                using var entryStream = entry.Open();
                var ms = new MemoryStream(capacity: (int)Math.Min(entry.Length, int.MaxValue));
                entryStream.CopyTo(ms);
                ms.Position = 0;
                current = ms;
            }

            return current;
        }
        catch
        {
            current.Dispose();
            throw;
        }
    }

    private static string? GetOriginalFileName(string displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return null;
        }

        var last = displayName;
        var idx = last.LastIndexOf(':');
        if (idx >= 0 && idx + 1 < last.Length)
        {
            last = last[(idx + 1)..];
        }

        last = last.Replace('\\', '/');
        var baseName = Path.GetFileName(last);
        return string.IsNullOrWhiteSpace(baseName) ? null : (baseName.Length > 260 ? baseName[^260..] : baseName);
    }
}
