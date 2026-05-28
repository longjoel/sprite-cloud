using System.Globalization;
using games_vault.Models;
using games_vault.Models.ViewModels;

namespace games_vault.Nosebleed;

public sealed class InstalledCoreInventoryBuilder
{
    public IReadOnlyList<InstalledCoreInventoryRow> Build(
        IReadOnlyCollection<string> installedNativeCores,
        IReadOnlyCollection<SystemCoreMapping> mappings)
    {
        var knownSystemsByCore = CoreCompatibilityCatalog.Entries
            .GroupBy(x => x.NativeCoreFileName, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                group => group.Key,
                group => group
                    .Select(x => x.SystemName)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                    .ToList() as IReadOnlyList<string>,
                StringComparer.OrdinalIgnoreCase);

        var mappedSystemsByCore = mappings
            .Where(x => !string.IsNullOrWhiteSpace(x.NativeCoreFileName))
            .GroupBy(x => x.NativeCoreFileName!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                group => group.Key,
                group => group
                    .Select(x => x.SystemName)
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                    .ToList() as IReadOnlyList<string>,
                StringComparer.OrdinalIgnoreCase);

        return installedNativeCores
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .Select(fileName =>
            {
                var knownSystems = knownSystemsByCore.GetValueOrDefault(fileName) ?? [];
                var usedBySystems = mappedSystemsByCore.GetValueOrDefault(fileName) ?? [];
                return new InstalledCoreInventoryRow
                {
                    FileName = fileName,
                    DisplayName = ToDisplayName(fileName),
                    IsKnownToCatalog = knownSystems.Count > 0,
                    KnownSystemNames = knownSystems,
                    UsedBySystemNames = usedBySystems
                };
            })
            .ToList();
    }

    public static string ToDisplayName(string fileName)
    {
        var originalFileName = fileName ?? string.Empty;
        var normalized = originalFileName.Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return string.Empty;
        }

        normalized = Path.GetFileNameWithoutExtension(normalized);
        if (normalized.EndsWith("_libretro", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[..^"_libretro".Length];
        }

        normalized = normalized.Replace('_', ' ').Replace('-', ' ').Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return originalFileName;
        }

        return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(normalized.ToLowerInvariant());
    }
}
