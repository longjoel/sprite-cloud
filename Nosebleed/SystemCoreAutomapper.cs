using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Nosebleed;

public sealed record SystemCoreAutomapResult(int Created, int Updated, int MissingCore, int UnknownSystem);

public sealed class SystemCoreAutomapper(AppDbContext db)
{
    public async Task<SystemCoreAutomapResult> AutoMapDetectedSystemsAsync(
        IReadOnlyCollection<string> installedNativeCores,
        CancellationToken cancellationToken = default)
    {
        var installed = installedNativeCores.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var systems = await db.Games
            .AsNoTracking()
            .Select(x => x.SystemName)
            .Distinct()
            .ToListAsync(cancellationToken);

        var mappings = await db.SystemCoreMappings
            .ToDictionaryAsync(x => x.SystemName, StringComparer.OrdinalIgnoreCase, cancellationToken);

        var created = 0;
        var updated = 0;
        var missingCore = 0;
        var unknownSystem = 0;

        foreach (var rawSystemName in systems)
        {
            var systemName = rawSystemName.Trim();
            if (string.IsNullOrWhiteSpace(systemName))
            {
                continue;
            }

            var entry = CoreCompatibilityCatalog.Find(systemName);
            if (entry is null)
            {
                unknownSystem++;
                continue;
            }

            if (!installed.Contains(entry.NativeCoreFileName))
            {
                missingCore++;
                continue;
            }

            if (mappings.TryGetValue(systemName, out var existing))
            {
                if (!existing.IsAutoMapped && (!string.IsNullOrWhiteSpace(existing.NativeCoreFileName) || !string.IsNullOrWhiteSpace(existing.WebPlayerCoreKey)))
                {
                    continue;
                }

                if (string.Equals(existing.NativeCoreFileName, entry.NativeCoreFileName, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(existing.WebPlayerCoreKey, entry.WebPlayerCoreKey, StringComparison.OrdinalIgnoreCase) &&
                    existing.IsEnabled && existing.IsAutoMapped)
                {
                    continue;
                }

                existing.NativeCoreFileName = entry.NativeCoreFileName;
                existing.WebPlayerCoreKey = entry.WebPlayerCoreKey;
                existing.IsEnabled = true;
                existing.IsAutoMapped = true;
                existing.Notes = string.IsNullOrWhiteSpace(existing.Notes)
                    ? $"Auto-mapped from built-in {entry.Confidence} compatibility catalog."
                    : existing.Notes;
                existing.UpdatedUtc = DateTime.UtcNow;
                updated++;
                continue;
            }

            var mapping = new SystemCoreMapping
            {
                SystemName = systemName,
                NativeCoreFileName = entry.NativeCoreFileName,
                WebPlayerCoreKey = entry.WebPlayerCoreKey,
                IsEnabled = true,
                IsAutoMapped = true,
                Notes = $"Auto-mapped from built-in {entry.Confidence} compatibility catalog.",
                CreatedUtc = DateTime.UtcNow,
                UpdatedUtc = DateTime.UtcNow
            };
            db.SystemCoreMappings.Add(mapping);
            mappings[systemName] = mapping;
            created++;
        }

        if (created > 0 || updated > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return new SystemCoreAutomapResult(created, updated, missingCore, unknownSystem);
    }
}
