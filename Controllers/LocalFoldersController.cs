using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

public sealed class LocalFoldersController(AppDbContext db) : Controller
{
    public async Task<IActionResult> Index(int page = 1, int pageSize = 50, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = db.LocalFolders.AsNoTracking().OrderBy(x => x.Name);
        var totalCount = await query.CountAsync(cancellationToken);
        var folders = await query
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return View(new LocalFoldersIndexViewModel
        {
            Folders = folders,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount
        });
    }

    public IActionResult Create()
    {
        return View(new LocalFolderEditViewModel { Enabled = true });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(LocalFolderEditViewModel model, CancellationToken cancellationToken)
    {
        if (!ModelState.IsValid)
        {
            return View(model);
        }

        db.LocalFolders.Add(new LocalFolder
        {
            Name = model.Name,
            RootPath = model.RootPath,
            Enabled = model.Enabled,
            CreatedUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Edit(int id, CancellationToken cancellationToken)
    {
        var folder = await db.LocalFolders.FindAsync([id], cancellationToken);
        if (folder is null)
        {
            return NotFound();
        }

        return View(new LocalFolderEditViewModel
        {
            Id = folder.Id,
            Name = folder.Name,
            RootPath = folder.RootPath,
            Enabled = folder.Enabled
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Edit(int id, LocalFolderEditViewModel model, CancellationToken cancellationToken)
    {
        if (id != model.Id)
        {
            return BadRequest();
        }

        if (!ModelState.IsValid)
        {
            return View(model);
        }

        var existing = await db.LocalFolders.FindAsync([id], cancellationToken);
        if (existing is null)
        {
            return NotFound();
        }

        existing.Name = model.Name;
        existing.RootPath = model.RootPath;
        existing.Enabled = model.Enabled;

        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Delete(int id, CancellationToken cancellationToken)
    {
        var folder = await db.LocalFolders.FindAsync([id], cancellationToken);
        if (folder is null)
        {
            return NotFound();
        }

        return View(folder);
    }

    [HttpPost, ActionName(nameof(Delete))]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteConfirmed(int id, CancellationToken cancellationToken)
    {
        var folder = await db.LocalFolders.FindAsync([id], cancellationToken);
        if (folder is null)
        {
            return RedirectToAction(nameof(Index));
        }

        db.LocalFolders.Remove(folder);
        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }
}
