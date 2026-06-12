using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

[ServiceFilter(typeof(AdminOnlyFilter))]
public class GameFilesController(AppDbContext db, GameFileStorage fileStorage) : Controller
{
    public async Task<IActionResult> Index(string? q, int page = 1, int pageSize = 50, CancellationToken cancellationToken = default)
    {
        q = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = db.GameFiles
            .Include(x => x.Game)
            .AsQueryable();

        if (q is not null)
        {
            var qLower = q.ToLower();
            query = query.Where(f =>
                f.Name.ToLower().Contains(qLower) ||
                (f.Crc32 != null && f.Crc32.ToLower().Contains(qLower)) ||
                f.Game.Name.ToLower().Contains(qLower) ||
                f.Game.SystemName.ToLower().Contains(qLower));
        }

        var totalCount = await query.CountAsync(cancellationToken);

        var files = await query
            .OrderByDescending(x => x.Id)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return View(new GameFilesIndexViewModel
        {
            Files = files,
            Query = q,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount
        });
    }

    [HttpGet]
    public async Task<IActionResult> Download(int id, CancellationToken cancellationToken = default)
    {
        var file = await db.GameFiles
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);

        if (file is null)
        {
            return NotFound();
        }

        var downloadName = file.OriginalFileName ?? file.Name ?? $"gamefile-{file.Id}";
        downloadName = Path.GetFileName(downloadName.Replace(':', '_'));
        if (string.IsNullOrWhiteSpace(downloadName))
        {
            downloadName = $"gamefile-{file.Id}";
        }

        string? abs = null;
        if (!string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            var full = Path.GetFullPath(file.ExternalPath);
            var allowedRoots = await db.LocalFolders
                .AsNoTracking()
                .Where(f => f.Enabled)
                .Select(f => f.RootPath)
                .ToListAsync(cancellationToken);
            var allowed = allowedRoots.Any(root =>
            {
                if (string.IsNullOrWhiteSpace(root))
                    return false;
                var rootFull = Path.GetFullPath(root);
                if (!rootFull.EndsWith(Path.DirectorySeparatorChar))
                    rootFull += Path.DirectorySeparatorChar;
                return full.StartsWith(rootFull, StringComparison.Ordinal);
            });
            abs = allowed ? full : null;
        }
        else if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            abs = fileStorage.GetAbsolutePath(file.StoragePath);
        }

        if (string.IsNullOrWhiteSpace(abs) || !System.IO.File.Exists(abs))
        {
            return NotFound("File bytes not available.");
        }

        return PhysicalFile(abs, "application/octet-stream", downloadName);
    }

    public async Task<IActionResult> Create(int gameId)
    {
        var game = await db.Games.FindAsync(gameId);
        if (game is null)
        {
            return NotFound();
        }

        ViewData["Game"] = game;
        return View(new GameFile { GameId = gameId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(GameFile file)
    {
        var game = await db.Games.FindAsync(file.GameId);
        if (game is null)
        {
            return NotFound();
        }

        if (!ModelState.IsValid)
        {
            ViewData["Game"] = game;
            return View(file);
        }

        db.GameFiles.Add(file);
        await db.SaveChangesAsync();

        return RedirectToAction(nameof(GamesController.Details), "Games", new { id = file.GameId });
    }

    public async Task<IActionResult> Delete(int id)
    {
        var file = await db.GameFiles
            .Include(x => x.Game)
            .FirstOrDefaultAsync(x => x.Id == id);
        if (file is null)
        {
            return NotFound();
        }

        return View(file);
    }

    [HttpPost, ActionName(nameof(Delete))]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteConfirmed(int id)
    {
        var file = await db.GameFiles.FindAsync(id);
        if (file is null)
        {
            return RedirectToAction(nameof(GamesController.Index), "Games");
        }

        var gameId = file.GameId;
        db.GameFiles.Remove(file);
        await db.SaveChangesAsync();

        return RedirectToAction(nameof(GamesController.Details), "Games", new { id = gameId });
    }
}
