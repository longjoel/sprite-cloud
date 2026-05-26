using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Arcade;

public sealed class ArcadeGameFileResolver(AppDbContext db, GameFileStorage fileStorage)
{
    public async Task<(GameFile? File, string? ContentPath, string? Error)> ResolveAsync(ArcadeCabinet cabinet, CancellationToken cancellationToken)
    {
        var file = cabinet.GameFileId is not null
            ? await db.GameFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == cabinet.GameFileId.Value, cancellationToken)
            : await db.GameFiles.AsNoTracking()
                .Where(x => x.GameId == cabinet.GameId && (x.StoragePath != null || x.ExternalPath != null))
                .OrderBy(x => x.Name)
                .FirstOrDefaultAsync(cancellationToken);

        if (file is null)
        {
            return (null, null, "No stored or linked ROM file found for this cabinet's game.");
        }

        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            var abs = fileStorage.GetAbsolutePath(file.StoragePath);
            return File.Exists(abs) ? (file, abs, null) : (file, null, $"ROM file not found at '{abs}'.");
        }

        if (string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            return (file, null, "ROM file has no storage or external path.");
        }

        var full = Path.GetFullPath(file.ExternalPath);
        var allowedRoots = await db.LocalFolders
            .AsNoTracking()
            .Where(f => f.Enabled)
            .Select(f => f.RootPath)
            .ToListAsync(cancellationToken);

        var allowed = allowedRoots.Any(root =>
        {
            if (string.IsNullOrWhiteSpace(root)) return false;
            var rootFull = Path.GetFullPath(root);
            if (!rootFull.EndsWith(Path.DirectorySeparatorChar)) rootFull += Path.DirectorySeparatorChar;
            return full.StartsWith(rootFull, StringComparison.Ordinal);
        });

        if (!allowed)
        {
            return (file, null, "ROM file is outside enabled local library roots.");
        }

        return File.Exists(full) ? (file, full, null) : (file, null, $"ROM file not found at '{full}'.");
    }
}
