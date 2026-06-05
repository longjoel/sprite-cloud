using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

[ServiceFilter(typeof(AdminOnlyFilter))]
public sealed class WebSourcesController(AppDbContext db) : Controller
{
    public async Task<IActionResult> Index(int page = 1, int pageSize = 50, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = db.WebSources.AsNoTracking().OrderBy(x => x.Name);
        var totalCount = await query.CountAsync(cancellationToken);
        var sources = await query
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return View(new WebSourcesIndexViewModel
        {
            Sources = sources,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount
        });
    }

    public IActionResult Create()
    {
        return View(new WebSourceEditViewModel { Enabled = true });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(WebSourceEditViewModel model, CancellationToken cancellationToken)
    {
        if (!ModelState.IsValid)
        {
            return View(model);
        }

        db.WebSources.Add(new WebSource
        {
            Name = model.Name,
            IndexUrl = model.IndexUrl,
            AllowedExtensions = string.IsNullOrWhiteSpace(model.AllowedExtensions) ? null : model.AllowedExtensions.Trim(),
            Enabled = model.Enabled,
            CreatedUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Edit(int id, CancellationToken cancellationToken)
    {
        var src = await db.WebSources.FindAsync([id], cancellationToken);
        if (src is null)
        {
            return NotFound();
        }

        return View(new WebSourceEditViewModel
        {
            Id = src.Id,
            Name = src.Name,
            IndexUrl = src.IndexUrl,
            AllowedExtensions = src.AllowedExtensions,
            Enabled = src.Enabled
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Edit(int id, WebSourceEditViewModel model, CancellationToken cancellationToken)
    {
        if (id != model.Id)
        {
            return BadRequest();
        }

        if (!ModelState.IsValid)
        {
            return View(model);
        }

        var existing = await db.WebSources.FindAsync([id], cancellationToken);
        if (existing is null)
        {
            return NotFound();
        }

        existing.Name = model.Name;
        existing.IndexUrl = model.IndexUrl;
        existing.AllowedExtensions = string.IsNullOrWhiteSpace(model.AllowedExtensions) ? null : model.AllowedExtensions.Trim();
        existing.Enabled = model.Enabled;

        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Delete(int id, CancellationToken cancellationToken)
    {
        var src = await db.WebSources.FindAsync([id], cancellationToken);
        if (src is null)
        {
            return NotFound();
        }

        return View(src);
    }

    [HttpPost, ActionName(nameof(Delete))]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteConfirmed(int id, CancellationToken cancellationToken)
    {
        var src = await db.WebSources.FindAsync([id], cancellationToken);
        if (src is null)
        {
            return RedirectToAction(nameof(Index));
        }

        db.WebSources.Remove(src);
        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }
}
