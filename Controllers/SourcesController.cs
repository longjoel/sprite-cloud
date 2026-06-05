using games_vault.Data;
using games_vault.Models.ViewModels;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

[ServiceFilter(typeof(AdminOnlyFilter))]
public sealed class SourcesController(AppDbContext db) : Controller
{
    public async Task<IActionResult> Index(
        int sharesPage = 1,
        int sharesPageSize = 50,
        int localPage = 1,
        int localPageSize = 50,
        int webPage = 1,
        int webPageSize = 50,
        CancellationToken cancellationToken = default)
    {
        sharesPage = Math.Max(1, sharesPage);
        sharesPageSize = Math.Clamp(sharesPageSize, 10, 100);
        localPage = Math.Max(1, localPage);
        localPageSize = Math.Clamp(localPageSize, 10, 100);
        webPage = Math.Max(1, webPage);
        webPageSize = Math.Clamp(webPageSize, 10, 100);

        var sharesQuery = db.NetworkShares.AsNoTracking().OrderBy(x => x.Name);
        var localQuery = db.LocalFolders.AsNoTracking().OrderBy(x => x.Name);
        var webQuery = db.WebSources.AsNoTracking().OrderBy(x => x.Name);

        var sharesTotal = await sharesQuery.CountAsync(cancellationToken);
        var localTotal = await localQuery.CountAsync(cancellationToken);
        var webTotal = await webQuery.CountAsync(cancellationToken);

        var sharesPageCount = sharesPageSize <= 0 ? 0 : (int)Math.Ceiling(sharesTotal / (double)sharesPageSize);
        var localPageCount = localPageSize <= 0 ? 0 : (int)Math.Ceiling(localTotal / (double)localPageSize);
        var webPageCount = webPageSize <= 0 ? 0 : (int)Math.Ceiling(webTotal / (double)webPageSize);

        sharesPage = Math.Min(sharesPage, Math.Max(1, sharesPageCount));
        localPage = Math.Min(localPage, Math.Max(1, localPageCount));
        webPage = Math.Min(webPage, Math.Max(1, webPageCount));

        var shares = await sharesQuery
            .Skip((sharesPage - 1) * sharesPageSize)
            .Take(sharesPageSize)
            .ToListAsync(cancellationToken);

        var locals = await localQuery
            .Skip((localPage - 1) * localPageSize)
            .Take(localPageSize)
            .ToListAsync(cancellationToken);

        var webSources = await webQuery
            .Skip((webPage - 1) * webPageSize)
            .Take(webPageSize)
            .ToListAsync(cancellationToken);

        return View(new SourcesIndexViewModel
        {
            NetworkShares = shares,
            NetworkSharesPage = sharesPage,
            NetworkSharesPageSize = sharesPageSize,
            NetworkSharesTotalCount = sharesTotal,

            LocalFolders = locals,
            LocalFoldersPage = localPage,
            LocalFoldersPageSize = localPageSize,
            LocalFoldersTotalCount = localTotal,

            WebSources = webSources,
            WebSourcesPage = webPage,
            WebSourcesPageSize = webPageSize,
            WebSourcesTotalCount = webTotal
        });
    }
}
