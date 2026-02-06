using games_vault.Data;
using games_vault.Models.ViewModels;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

public sealed class DownloadsController(AppDbContext db, IWebHostEnvironment env) : Controller
{
    public async Task<IActionResult> Index(int page = 1, int pageSize = 50, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = db.Artifacts.AsNoTracking();
        var totalCount = await query.CountAsync(cancellationToken);

        var artifacts = await query
            .OrderByDescending(x => x.CreatedUtc)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return View(new DownloadsIndexViewModel
        {
            Artifacts = artifacts,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount
        });
    }

    public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
    {
        var artifact = await db.Artifacts.FindAsync([id], cancellationToken);
        if (artifact is null)
        {
            return NotFound();
        }

        var abs = Path.GetFullPath(Path.Combine(env.ContentRootPath, artifact.StoragePath.Replace('/', Path.DirectorySeparatorChar)));
        var root = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data"));
        if (!abs.StartsWith(root, StringComparison.Ordinal) || !System.IO.File.Exists(abs))
        {
            return NotFound();
        }

        var contentType = string.IsNullOrWhiteSpace(artifact.ContentType) ? "application/octet-stream" : artifact.ContentType;
        return PhysicalFile(abs, contentType, fileDownloadName: artifact.FileName);
    }
}
