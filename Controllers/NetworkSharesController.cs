using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

[ServiceFilter(typeof(AdminOnlyFilter))]
public class NetworkSharesController(AppDbContext db) : Controller
{
    public async Task<IActionResult> Index(int page = 1, int pageSize = 50, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 100);

        var query = db.NetworkShares.AsNoTracking().OrderBy(x => x.Name);
        var totalCount = await query.CountAsync(cancellationToken);
        var shares = await query
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return View(new NetworkSharesIndexViewModel
        {
            Shares = shares,
            Page = page,
            PageSize = pageSize,
            TotalCount = totalCount
        });
    }

    public IActionResult Create()
    {
        return View(new NetworkShareEditViewModel { Enabled = true });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(NetworkShareEditViewModel model, CancellationToken cancellationToken)
    {
        if (!ModelState.IsValid)
        {
            return View(model);
        }

        db.NetworkShares.Add(new NetworkShare
        {
            Name = model.Name,
            RootPath = model.RootPath,
            Username = string.IsNullOrWhiteSpace(model.Username) ? null : model.Username.Trim(),
            Password = string.IsNullOrWhiteSpace(model.Password) ? null : model.Password,
            Enabled = model.Enabled,
            CreatedUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Edit(int id, CancellationToken cancellationToken)
    {
        var share = await db.NetworkShares.FindAsync([id], cancellationToken);
        if (share is null)
        {
            return NotFound();
        }

        return View(new NetworkShareEditViewModel
        {
            Id = share.Id,
            Name = share.Name,
            RootPath = share.RootPath,
            Username = share.Username,
            Password = null, // don't echo stored password
            Enabled = share.Enabled
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Edit(int id, NetworkShareEditViewModel model, CancellationToken cancellationToken)
    {
        if (id != model.Id)
        {
            return BadRequest();
        }

        if (!ModelState.IsValid)
        {
            return View(model);
        }

        var existing = await db.NetworkShares.FindAsync([id], cancellationToken);
        if (existing is null)
        {
            return NotFound();
        }

        existing.Name = model.Name;
        existing.RootPath = model.RootPath;
        existing.Username = string.IsNullOrWhiteSpace(model.Username) ? null : model.Username.Trim();
        if (!string.IsNullOrWhiteSpace(model.Password))
        {
            existing.Password = model.Password;
        }
        existing.Enabled = model.Enabled;

        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Delete(int id, CancellationToken cancellationToken)
    {
        var share = await db.NetworkShares.FindAsync([id], cancellationToken);
        if (share is null)
        {
            return NotFound();
        }

        return View(share);
    }

    [HttpPost, ActionName(nameof(Delete))]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteConfirmed(int id, CancellationToken cancellationToken)
    {
        var share = await db.NetworkShares.FindAsync([id], cancellationToken);
        if (share is null)
        {
            return RedirectToAction(nameof(Index));
        }

        db.NetworkShares.Remove(share);
        await db.SaveChangesAsync(cancellationToken);
        return RedirectToAction(nameof(Index));
    }
}
