using System.IO.Compression;
using System.Text.Json;
using games_vault.Data;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record SystemFilesImportFromLocalFolderPayload(int LocalFolderId, string? Query = null, bool Overwrite = false, int MaxFiles = 50_000, bool OnlyMissing = false);

[BackgroundJobCommand("systemfiles.local")]
public sealed class ImportSystemFilesFromLocalFolderCommand(
    AppDbContext db,
    SystemDatIndexProvider systemDat,
    SystemFileStorage storage) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<SystemFilesImportFromLocalFolderPayload>(JobJson.Options);
        if (typed is null || typed.LocalFolderId <= 0)
        {
            throw new InvalidOperationException("systemfiles.local payload must include a localFolderId.");
        }

        var folder = await db.LocalFolders.FirstOrDefaultAsync(x => x.Id == typed.LocalFolderId, cancellationToken);
        if (folder is null || !folder.Enabled)
        {
            throw new InvalidOperationException("Local folder not found or disabled.");
        }

        var root = folder.RootPath;
        if (!Directory.Exists(root))
        {
            throw new InvalidOperationException($"Local folder path not found: {root}");
        }

        var idx = systemDat.Get();
        var q = string.IsNullOrWhiteSpace(typed.Query) ? null : typed.Query.Trim().ToLowerInvariant();
        var max = Math.Clamp(typed.MaxFiles, 1, 200_000);

        var existingByPath = await db.SystemFiles
            .Where(x => x.TargetPath != null && x.TargetPath != "")
            .ToDictionaryAsync(x => x.TargetPath!, StringComparer.OrdinalIgnoreCase, cancellationToken);

        var scanned = 0;
        var matched = 0;
        var skipped = 0;
        var unmatched = 0;
        var ignored = 0;

        var missingTargetsByCrc = typed.OnlyMissing ? BuildMissingTargetsByCrc(idx) : null;

        var stagingRoot = Path.Combine(Path.GetTempPath(), "gv-system-source", context.Job.Id.ToString(), "local");
        Directory.CreateDirectory(stagingRoot);

        try
        {
            await context.LogInfoAsync($"System files scan started: localFolder='{folder.Name}' path='{root}' query='{typed.Query ?? ""}' overwrite={typed.Overwrite} maxFiles={max}", cancellationToken);

            foreach (var filePath in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (scanned >= max)
                {
                    break;
                }

                var fileName = Path.GetFileName(filePath);
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    continue;
                }

                if (q is not null && !fileName.ToLowerInvariant().Contains(q))
                {
                    continue;
                }

                scanned++;

                try
                {
                    if (fileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                    {
                        var zipUnmatched = await ProcessZipFileAsync(filePath, q, typed.Overwrite, idx, existingByPath, stagingRoot, missingTargetsByCrc, cancellationToken);
                        matched += zipUnmatched.Matched;
                        skipped += zipUnmatched.Skipped;
                        unmatched += zipUnmatched.Unmatched;
                        ignored += zipUnmatched.Ignored;
                    }
                    else
                    {
                        var res = await ProcessFileAsync(filePath, fileName, typed.Overwrite, idx, existingByPath, missingTargetsByCrc, cancellationToken);
                        matched += res.Matched;
                        skipped += res.Skipped;
                        unmatched += res.Unmatched;
                        ignored += res.Ignored;
                    }
                }
                catch
                {
                    // Keep scanning other files.
                }

                if (scanned % 100 == 0)
                {
                    await db.SaveChangesAsync(cancellationToken);
                    await context.SetProgressPermilleAsync(Math.Min(950, scanned * 1000 / max), cancellationToken);
                    await context.TouchLeaseAsync(TimeSpan.FromMinutes(10), cancellationToken);
                }
            }

            await db.SaveChangesAsync(cancellationToken);
        }
        finally
        {
            try { Directory.Delete(stagingRoot, recursive: true); } catch { }
        }

        await context.LogInfoAsync($"System files scan finished: scanned={scanned} matched={matched} skipped={skipped} unmatched={unmatched} ignored={ignored} onlyMissing={typed.OnlyMissing}", cancellationToken);
        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }

    private async Task<(int Matched, int Skipped, int Unmatched, int Ignored)> ProcessFileAsync(
        string filePath,
        string originalName,
        bool overwrite,
        SystemDatIndex idx,
        Dictionary<string, SystemFile> existingByPath,
        IReadOnlyDictionary<string, IReadOnlyList<SystemDatRom>>? missingTargetsByCrc,
        CancellationToken cancellationToken)
    {
        await using var fs = System.IO.File.OpenRead(filePath);
        var crc = await Crc32.ComputeAsync(fs, cancellationToken);
        var crcStr = crc.ToString("X8");

        if (missingTargetsByCrc is not null)
        {
            if (!missingTargetsByCrc.TryGetValue(crcStr, out var targets) || targets.Count == 0)
            {
                return (0, 0, 0, 1);
            }

            var placed = 0;
            var skippedTargets = 0;

            foreach (var t in targets)
            {
                var rel = t.RelativePath;
                var abs = storage.GetAbsoluteSystemPath(rel);
                if (System.IO.File.Exists(abs) && !overwrite)
                {
                    skippedTargets++;
                    continue;
                }

                var dir = Path.GetDirectoryName(abs);
                if (!string.IsNullOrWhiteSpace(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                System.IO.File.Copy(filePath, abs, overwrite: true);

                var infoT = new FileInfo(filePath);
                UpsertMetadata(t, rel, originalName, crcStr, infoT.Exists ? infoT.Length : 0, existingByPath);
                placed++;
            }

            return (placed, skippedTargets, 0, 0);
        }

        if (!idx.ByCrc32.TryGetValue(crcStr, out var def))
        {
            return (0, 0, 1, 0);
        }

        var relOne = def.RelativePath;
        var absOne = storage.GetAbsoluteSystemPath(relOne);
        if (System.IO.File.Exists(absOne) && !overwrite)
        {
            return (0, 1, 0, 0);
        }

        var dirOne = Path.GetDirectoryName(absOne);
        if (!string.IsNullOrWhiteSpace(dirOne))
        {
            Directory.CreateDirectory(dirOne);
        }

        System.IO.File.Copy(filePath, absOne, overwrite: true);

        var info = new FileInfo(filePath);
        UpsertMetadata(def, relOne, originalName, crcStr, info.Exists ? info.Length : 0, existingByPath);

        return (1, 0, 0, 0);
    }

    private async Task<(int Matched, int Skipped, int Unmatched, int Ignored)> ProcessZipFileAsync(
        string zipPath,
        string? q,
        bool overwrite,
        SystemDatIndex idx,
        Dictionary<string, SystemFile> existingByPath,
        string stagingRoot,
        IReadOnlyDictionary<string, IReadOnlyList<SystemDatRom>>? missingTargetsByCrc,
        CancellationToken cancellationToken)
    {
        var matched = 0;
        var skipped = 0;
        var unmatched = 0;
        var ignored = 0;

        using var zip = ZipFile.OpenRead(zipPath);
        foreach (var entry in zip.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (string.IsNullOrWhiteSpace(entry.Name))
            {
                continue;
            }

            if (q is not null && !entry.Name.ToLowerInvariant().Contains(q))
            {
                continue;
            }

            var tmp = Path.Combine(stagingRoot, Guid.NewGuid().ToString("N"));
            var crcStr = "";
            await using (var tmpOut = System.IO.File.Create(tmp))
            {
                await using var es = entry.Open();

                uint crc = 0xFFFFFFFF;
                var buffer = new byte[1024 * 64];
                while (true)
                {
                    var read = await es.ReadAsync(buffer, cancellationToken);
                    if (read <= 0) break;
                    crc = Crc32.Update(crc, buffer.AsSpan(0, read));
                    await tmpOut.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }

                crc = ~crc;
                crcStr = crc.ToString("X8");
            }

            try
            {
                if (missingTargetsByCrc is not null)
                {
                    if (!missingTargetsByCrc.TryGetValue(crcStr, out var targets) || targets.Count == 0)
                    {
                        ignored++;
                        continue;
                    }

                    foreach (var t in targets)
                    {
                        var rel = t.RelativePath;
                        var abs = storage.GetAbsoluteSystemPath(rel);
                        if (System.IO.File.Exists(abs) && !overwrite)
                        {
                            skipped++;
                            continue;
                        }

                        var dir = Path.GetDirectoryName(abs);
                        if (!string.IsNullOrWhiteSpace(dir))
                        {
                            Directory.CreateDirectory(dir);
                        }

                        System.IO.File.Copy(tmp, abs, overwrite: true);
                        UpsertMetadata(t, rel, entry.Name, crcStr, entry.Length, existingByPath);
                        matched++;
                    }

                    continue;
                }

                if (!idx.ByCrc32.TryGetValue(crcStr, out var def))
                {
                    unmatched++;
                    continue;
                }

                var relOne = def.RelativePath;
                var absOne = storage.GetAbsoluteSystemPath(relOne);
                if (System.IO.File.Exists(absOne) && !overwrite)
                {
                    skipped++;
                    continue;
                }

                var dirOne = Path.GetDirectoryName(absOne);
                if (!string.IsNullOrWhiteSpace(dirOne))
                {
                    Directory.CreateDirectory(dirOne);
                }

                System.IO.File.Copy(tmp, absOne, overwrite: true);
                UpsertMetadata(def, relOne, entry.Name, crcStr, entry.Length, existingByPath);
                matched++;
            }
            finally
            {
                try { System.IO.File.Delete(tmp); } catch { }
            }
        }

        return (matched, skipped, unmatched, ignored);
    }

    private void UpsertMetadata(
        SystemDatRom def,
        string rel,
        string originalName,
        string crc32,
        long sizeBytes,
        Dictionary<string, SystemFile> existingByPath)
    {
        var storagePath = Path.Combine("App_Data", "library", "system", rel).Replace('\\', '/');
        var fileName = Path.GetFileName(rel);

        if (!existingByPath.TryGetValue(rel, out var entity))
        {
            entity = new SystemFile { TargetPath = rel, CreatedUtc = DateTime.UtcNow };
            db.SystemFiles.Add(entity);
            existingByPath[rel] = entity;
        }

        entity.SystemName = def.SystemGroup;
        entity.Kind = "bios";
        entity.FileName = fileName;
        entity.OriginalFileName = Path.GetFileName(originalName);
        entity.Crc32 = crc32;
        entity.SizeBytes = sizeBytes;
        entity.StoragePath = storagePath;
    }

    private IReadOnlyDictionary<string, IReadOnlyList<SystemDatRom>> BuildMissingTargetsByCrc(SystemDatIndex idx)
    {
        var map = new Dictionary<string, List<SystemDatRom>>(StringComparer.OrdinalIgnoreCase);

        foreach (var def in idx.ByPath.Values)
        {
            var abs = storage.GetAbsoluteSystemPath(def.RelativePath);
            if (System.IO.File.Exists(abs))
            {
                continue;
            }

            if (!map.TryGetValue(def.Crc32, out var list))
            {
                list = new List<SystemDatRom>();
                map[def.Crc32] = list;
            }

            list.Add(def);
        }

        return map.ToDictionary(k => k.Key, v => (IReadOnlyList<SystemDatRom>)v.Value, StringComparer.OrdinalIgnoreCase);
    }
}
