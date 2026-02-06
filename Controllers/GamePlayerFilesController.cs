using games_vault.Data;
using games_vault.Web;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;

namespace games_vault.Controllers;

public sealed class GamePlayerFilesController(AppDbContext db, WebPlayerDataStorage storage, IAntiforgery antiforgery) : Controller
{
    private static readonly SemaphoreSlim WriteGate = new(1, 1);

    [HttpGet]
    public IActionResult Token()
    {
        var tokens = antiforgery.GetAndStoreTokens(HttpContext);
        return Json(new { token = tokens.RequestToken });
    }

    [HttpGet]
    public async Task<IActionResult> List(int gameId, CancellationToken cancellationToken = default)
    {
        if (gameId <= 0)
        {
            return BadRequest("Invalid gameId.");
        }

        var exists = await db.Games.AsNoTracking().AnyAsync(g => g.Id == gameId, cancellationToken);
        if (!exists)
        {
            return NotFound();
        }

        var items = await db.GamePlayerFiles
            .AsNoTracking()
            .Where(x => x.GameId == gameId)
            .OrderBy(x => x.Kind)
            .ThenBy(x => x.Key)
            .ThenBy(x => x.FileName)
            .Select(x => new
            {
                x.Id,
                x.Kind,
                x.Key,
                x.FileName,
                x.SizeBytes,
                x.CreatedUtc,
                x.UpdatedUtc,
                url = Url.Action(nameof(Get), new { id = x.Id })
            })
            .ToListAsync(cancellationToken);

        return Json(new { gameId, items });
    }

    [HttpGet]
    public async Task<IActionResult> Get(int id, CancellationToken cancellationToken = default)
    {
        var item = await db.GamePlayerFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (item is null)
        {
            return NotFound();
        }

        var abs = storage.GetAbsolutePath(item.StoragePath);
        if (!System.IO.File.Exists(abs))
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store";
        return PhysicalFile(abs, "application/octet-stream", fileDownloadName: item.FileName);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Put(
        int gameId,
        string kind,
        string key,
        string? fileName,
        IFormFile file,
        CancellationToken cancellationToken = default)
    {
        if (gameId <= 0)
        {
            return BadRequest("Invalid gameId.");
        }

        var gameExists = await db.Games.AnyAsync(g => g.Id == gameId, cancellationToken);
        if (!gameExists)
        {
            return NotFound();
        }

        if (file is null || file.Length <= 0)
        {
            return BadRequest("File is required.");
        }

        kind = (kind ?? "").Trim();
        if (!string.Equals(kind, "userdata", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest("Invalid kind.");
        }

        key = (key ?? "").Trim();
        fileName = string.IsNullOrWhiteSpace(fileName) ? file.FileName : fileName.Trim();
        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = "file.bin";
        }

        // Serialize writes to avoid SQLite 'database is locked' under heavy client sync.
        await WriteGate.WaitAsync(cancellationToken);
        try
        {
        var (storagePath, sizeBytes) = await storage.StoreAsync(
            gameId,
            kind,
            key,
            fileName,
            openStream: () => file.OpenReadStream(),
            cancellationToken);

        var now = DateTime.UtcNow;

        var existing = await db.GamePlayerFiles
            .FirstOrDefaultAsync(x => x.GameId == gameId && x.Kind == kind && x.Key == key && x.FileName == fileName, cancellationToken);

        if (existing is null)
        {
            db.GamePlayerFiles.Add(new games_vault.Models.GamePlayerFile
            {
                GameId = gameId,
                Kind = kind,
                Key = key,
                FileName = fileName,
                StoragePath = storagePath,
                SizeBytes = sizeBytes,
                CreatedUtc = now,
                UpdatedUtc = now
            });
        }
        else
        {
            existing.StoragePath = storagePath;
            existing.SizeBytes = sizeBytes;
            existing.UpdatedUtc = now;
        }

        // Retry on transient SQLite lock.
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                await db.SaveChangesAsync(cancellationToken);
                break;
            }
            catch (DbUpdateException ex) when (IsSqliteLocked(ex) && attempt < 4)
            {
                await Task.Delay(50 * (attempt + 1), cancellationToken);
            }
        }

        return Ok(new { gameId, kind, key, fileName, sizeBytes });
        }
        finally
        {
            WriteGate.Release();
        }
    }

    private static bool IsSqliteLocked(DbUpdateException ex)
    {
        var inner = ex.InnerException;
        while (inner is not null)
        {
            if (inner is SqliteException sx && sx.SqliteErrorCode == 5)
            {
                return true;
            }

            inner = inner.InnerException;
        }

        return false;
    }
}
