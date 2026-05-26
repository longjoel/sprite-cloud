using games_vault.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed record DetectedSystemCoreMapping(
    string SystemName,
    string? NativeCoreFileName,
    string? WebPlayerCoreKey,
    bool IsEnabled,
    int GameCount)
{
    public bool HasNativeCoreMapping => IsEnabled && !string.IsNullOrWhiteSpace(NativeCoreFileName);
}

public sealed class SystemCoreMappingResolver(AppDbContext db, IOptions<NosebleedOptions> nosebleedOptions)
{
    private readonly NosebleedOptions _nosebleedOptions = nosebleedOptions.Value ?? new NosebleedOptions();

    public async Task<string?> ResolveNativeCoreAsync(string systemName, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(systemName))
        {
            return null;
        }

        var normalized = systemName.Trim();
        var mapping = await db.SystemCoreMappings
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.SystemName == normalized && x.IsEnabled, cancellationToken);

        if (!string.IsNullOrWhiteSpace(mapping?.NativeCoreFileName))
        {
            return mapping.NativeCoreFileName.Trim();
        }

        return _nosebleedOptions.SystemCores.TryGetValue(normalized, out var fallback) && !string.IsNullOrWhiteSpace(fallback)
            ? fallback.Trim()
            : null;
    }

    public async Task<IReadOnlyList<DetectedSystemCoreMapping>> GetDetectedSystemsAsync(CancellationToken cancellationToken = default)
    {
        var systems = await db.Games
            .AsNoTracking()
            .GroupBy(g => g.SystemName)
            .Select(g => new { SystemName = g.Key, GameCount = g.Count() })
            .OrderBy(x => x.SystemName)
            .ToListAsync(cancellationToken);

        var mappings = await db.SystemCoreMappings
            .AsNoTracking()
            .ToDictionaryAsync(x => x.SystemName, StringComparer.OrdinalIgnoreCase, cancellationToken);

        return systems.Select(system =>
        {
            mappings.TryGetValue(system.SystemName, out var mapping);
            var nativeCore = mapping?.NativeCoreFileName;
            if (string.IsNullOrWhiteSpace(nativeCore) &&
                _nosebleedOptions.SystemCores.TryGetValue(system.SystemName, out var fallback) &&
                !string.IsNullOrWhiteSpace(fallback))
            {
                nativeCore = fallback.Trim();
            }

            return new DetectedSystemCoreMapping(
                system.SystemName,
                nativeCore,
                mapping?.WebPlayerCoreKey,
                mapping?.IsEnabled ?? true,
                system.GameCount);
        }).ToList();
    }
}
