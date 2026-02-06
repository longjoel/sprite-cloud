using games_vault.Data;
using games_vault.BackgroundJobs;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.IO.Compression;

namespace games_vault.Controllers;

public sealed class SystemFilesController(
    AppDbContext db,
    SystemFileStorage storage,
    SystemDatIndexProvider systemDat,
    IInternalJobsClient internalJobs) : Controller
{
    public async Task<IActionResult> Index(string? q, int page = 1, int pageSize = 50, CancellationToken cancellationToken = default)
    {
        q = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = db.SystemFiles.AsQueryable();

        if (q is not null)
        {
            var qLower = q.ToLower();
            query = query.Where(f =>
                f.FileName.ToLower().Contains(qLower) ||
                f.SystemName.ToLower().Contains(qLower) ||
                f.Kind.ToLower().Contains(qLower) ||
                (f.Crc32 != null && f.Crc32.ToLower().Contains(qLower)));
        }

        var totalCount = await query.CountAsync(cancellationToken);

        var files = await query
            .OrderByDescending(x => x.Id)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        var recentJobs = await db.BackgroundJobs
            .AsNoTracking()
            .Where(x => x.Command == "systemfiles.local" || x.Command == "systemfiles.share")
            .OrderByDescending(x => x.CreatedUtc)
            .Take(10)
            .ToListAsync(cancellationToken);

        return View(new SystemFilesIndexViewModel
        {
            Files = files,
            Query = q,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount,
            RecentJobs = recentJobs
        });
    }

    public async Task<IActionResult> Missing(CancellationToken cancellationToken = default)
    {
        Response.Headers.CacheControl = "no-store";
        var idx = systemDat.Get();
        var groups = idx.ByPath.Values
            .GroupBy(x => x.SystemGroup)
            .OrderBy(g => g.Key)
            .Select(g =>
            {
                var items = g
                    .OrderBy(x => x.RelativePath)
                    .Select(x => new
                    {
                        x.SystemGroup,
                        x.RelativePath,
                        x.Crc32,
                        Exists = System.IO.File.Exists(storage.GetAbsoluteSystemPath(x.RelativePath))
                    })
                    .Where(x => !x.Exists)
                    .ToList();

                return new SystemFilesMissingGroup(
                    System: g.Key,
                    Missing: items.Select(x => new SystemFilesMissingItem(x.RelativePath, x.Crc32)).ToList());
            })
            .Where(x => x.Missing.Count > 0)
            .ToList();

        var localFolders = await db.LocalFolders
            .AsNoTracking()
            .Where(x => x.Enabled)
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);

        var networkShares = await db.NetworkShares
            .AsNoTracking()
            .Where(x => x.Enabled)
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);

        return View(new SystemFilesMissingViewModel
        {
            Groups = groups,
            LocalFolders = localFolders,
            NetworkShares = networkShares
        });
    }

    public async Task<IActionResult> Create(CancellationToken cancellationToken)
    {
        ViewData["Systems"] = await db.Games
            .AsNoTracking()
            .Select(x => x.SystemName)
            .Distinct()
            .OrderBy(x => x)
            .ToListAsync(cancellationToken);

        ViewData["KnownPaths"] = systemDat.Get().ByPath.Keys.OrderBy(x => x).ToList();
        return View();
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(string systemName, string kind, string? targetPath, IFormFile file, CancellationToken cancellationToken)
    {
        systemName = (systemName ?? "").Trim();
        kind = string.IsNullOrWhiteSpace(kind) ? "bios" : kind.Trim().ToLowerInvariant();
        targetPath = SystemDatIndex.NormalizeRelativePath(targetPath ?? "");

        if (string.IsNullOrWhiteSpace(systemName))
        {
            ModelState.AddModelError(nameof(systemName), "System is required.");
        }

        if (file is null || file.Length <= 0)
        {
            ModelState.AddModelError(nameof(file), "File is required.");
        }

        if (!ModelState.IsValid)
        {
            ViewData["Systems"] = await db.Games
                .AsNoTracking()
                .Select(x => x.SystemName)
                .Distinct()
                .OrderBy(x => x)
                .ToListAsync(cancellationToken);

            ViewData["KnownPaths"] = systemDat.Get().ByPath.Keys.OrderBy(x => x).ToList();
            return View();
        }

        if (file is null)
        {
            return BadRequest();
        }

        string? crc32 = null;
        await using (var input = file.OpenReadStream())
        {
            var crc = await Crc32.ComputeAsync(input, cancellationToken);
            crc32 = crc.ToString("X8");
        }

        // Auto-place based on libretro System.dat when possible.
        if (string.IsNullOrWhiteSpace(targetPath) && crc32 is not null)
        {
            var idx = systemDat.Get();
            if (idx.ByCrc32.TryGetValue(crc32, out var def))
            {
                targetPath = def.RelativePath;
                systemName = def.SystemGroup;
                kind = "bios";
            }
        }

        string storagePath;
        if (!string.IsNullOrWhiteSpace(targetPath))
        {
            storagePath = await storage.StoreToSystemPathAsync(
                openStream: file.OpenReadStream,
                relativePath: targetPath,
                cancellationToken: cancellationToken);
        }
        else
        {
            storagePath = await storage.StoreAsync(
                openStream: file.OpenReadStream,
                systemName: systemName,
                displayName: file.FileName,
                crc32: crc32,
                cancellationToken: cancellationToken);
        }

        var entity = new SystemFile
        {
            SystemName = systemName,
            Kind = kind,
            FileName = !string.IsNullOrWhiteSpace(targetPath) ? Path.GetFileName(targetPath) : file.FileName,
            TargetPath = targetPath,
            OriginalFileName = Path.GetFileName(file.FileName),
            Crc32 = crc32,
            SizeBytes = file.Length,
            StoragePath = storagePath,
            CreatedUtc = DateTime.UtcNow
        };

        db.SystemFiles.Add(entity);
        await db.SaveChangesAsync(cancellationToken);

        TempData["Message"] = "System file uploaded.";
        return RedirectToAction(nameof(Index));
    }

    public IActionResult ImportPack()
    {
        return View();
    }

    public async Task<IActionResult> ImportSource(CancellationToken cancellationToken = default)
    {
        ViewData["LocalFolders"] = await db.LocalFolders
            .AsNoTracking()
            .Where(x => x.Enabled)
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);

        ViewData["NetworkShares"] = await db.NetworkShares
            .AsNoTracking()
            .Where(x => x.Enabled)
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);

        return View();
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartLocalSourceScan(int localFolderId, string? q, bool overwrite = false, int maxFiles = 50_000, bool onlyMissing = false, CancellationToken cancellationToken = default)
    {
        if (localFolderId <= 0)
        {
            TempData["Message"] = "Select a local folder.";
            return RedirectToAction(onlyMissing ? nameof(Missing) : nameof(ImportSource));
        }

        maxFiles = Math.Clamp(maxFiles, 1, 200_000);
        var jobId = await internalJobs.EnqueueSystemFilesImportFromLocalFolderAsync(localFolderId, q, overwrite, maxFiles, onlyMissing, cancellationToken);
        TempData["Message"] = $"Queued system files scan job #{jobId}.";
        return RedirectToAction(nameof(JobsController.Details), "Jobs", new { id = jobId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> StartNetworkSourceScan(int networkShareId, string? q, bool overwrite = false, int maxFiles = 50_000, bool onlyMissing = false, CancellationToken cancellationToken = default)
    {
        if (networkShareId <= 0)
        {
            TempData["Message"] = "Select a network share.";
            return RedirectToAction(onlyMissing ? nameof(Missing) : nameof(ImportSource));
        }

        maxFiles = Math.Clamp(maxFiles, 1, 200_000);
        var jobId = await internalJobs.EnqueueSystemFilesImportFromNetworkShareAsync(networkShareId, q, overwrite, maxFiles, onlyMissing, cancellationToken);
        TempData["Message"] = $"Queued system files scan job #{jobId}.";
        return RedirectToAction(nameof(JobsController.Details), "Jobs", new { id = jobId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ImportPack(IFormFile pack, bool overwrite = false, CancellationToken cancellationToken = default)
    {
        if (pack is null || pack.Length <= 0)
        {
            TempData["Message"] = "Select a .zip pack to upload.";
            return RedirectToAction(nameof(ImportPack));
        }

        var idx = systemDat.Get();

        var matched = 0;
        var skipped = 0;
        var unmatched = 0;

        var existingByPath = await db.SystemFiles
            .Where(x => x.TargetPath != null && x.TargetPath != "")
            .ToDictionaryAsync(x => x.TargetPath!, StringComparer.OrdinalIgnoreCase, cancellationToken);

        var stagingRoot = Path.Combine(Path.GetTempPath(), "gv-system-pack", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stagingRoot);

        try
        {
            await using var packStream = pack.OpenReadStream();
            using var zip = new ZipArchive(packStream, ZipArchiveMode.Read, leaveOpen: false);

            foreach (var entry in zip.Entries)
            {
                if (string.IsNullOrWhiteSpace(entry.Name))
                {
                    continue; // directory
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

                if (!idx.ByCrc32.TryGetValue(crcStr, out var def))
                {
                    unmatched++;
                    continue;
                }

                var rel = def.RelativePath;
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

                var storagePath = Path.Combine("App_Data", "library", "system", rel).Replace('\\', '/');
                var fileName = Path.GetFileName(rel);

                if (!existingByPath.TryGetValue(rel, out var existing))
                {
                    existing = new SystemFile
                    {
                        SystemName = def.SystemGroup,
                        Kind = "bios",
                        FileName = fileName,
                        TargetPath = rel,
                        OriginalFileName = entry.Name,
                        Crc32 = crcStr,
                        SizeBytes = entry.Length,
                        StoragePath = storagePath,
                        CreatedUtc = DateTime.UtcNow
                    };
                    db.SystemFiles.Add(existing);
                    existingByPath[rel] = existing;
                }
                else
                {
                    existing.SystemName = def.SystemGroup;
                    existing.Kind = "bios";
                    existing.FileName = fileName;
                    existing.OriginalFileName = entry.Name;
                    existing.Crc32 = crcStr;
                    existing.SizeBytes = entry.Length;
                    existing.StoragePath = storagePath;
                }

                matched++;
            }

            await db.SaveChangesAsync(cancellationToken);
        }
        finally
        {
            try { Directory.Delete(stagingRoot, recursive: true); } catch { }
        }

        TempData["Message"] = $"Imported pack: {matched} matched, {skipped} skipped, {unmatched} unmatched.";
        return RedirectToAction(nameof(Index));
    }

    [HttpGet]
    public async Task<IActionResult> Download(int id, CancellationToken cancellationToken = default)
    {
        var file = await db.SystemFiles
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);

        if (file is null)
        {
            return NotFound();
        }

        var abs = !string.IsNullOrWhiteSpace(file.TargetPath)
            ? storage.GetAbsoluteSystemPath(file.TargetPath)
            : storage.GetAbsolutePath(file.StoragePath);
        if (!System.IO.File.Exists(abs))
        {
            return NotFound("File bytes not available.");
        }

        var downloadName = Path.GetFileName(file.OriginalFileName ?? file.FileName ?? $"systemfile-{file.Id}");
        if (string.IsNullOrWhiteSpace(downloadName))
        {
            downloadName = $"systemfile-{file.Id}";
        }

        return PhysicalFile(abs, "application/octet-stream", downloadName);
    }

    public async Task<IActionResult> Delete(int id, CancellationToken cancellationToken = default)
    {
        var file = await db.SystemFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        return View(file);
    }

    [HttpPost, ActionName(nameof(Delete))]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteConfirmed(int id, CancellationToken cancellationToken = default)
    {
        var file = await db.SystemFiles.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (file is null)
        {
            return RedirectToAction(nameof(Index));
        }

        var abs = !string.IsNullOrWhiteSpace(file.TargetPath)
            ? storage.GetAbsoluteSystemPath(file.TargetPath)
            : storage.GetAbsolutePath(file.StoragePath);
        db.SystemFiles.Remove(file);
        await db.SaveChangesAsync(cancellationToken);

        try
        {
            if (System.IO.File.Exists(abs))
            {
                System.IO.File.Delete(abs);
            }
        }
        catch
        {
            // Best-effort delete; metadata is already removed.
        }

        TempData["Message"] = "System file deleted.";
        return RedirectToAction(nameof(Index));
    }
}
