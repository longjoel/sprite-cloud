using System.Text.RegularExpressions;
using games_vault.Libretro.Dat;

namespace games_vault.Libretro.Import;

internal static partial class ArcadeRomFileNameNormalizer
{
    public static bool IsArcadeZipMatch(LibretroDatRomEntry match, string displayName) =>
        IsArcadeSystem(match.SystemName)
        && IsTopLevelZip(displayName)
        && match.RomName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);

    public static string? TryNormalizeLookupFileName(string displayName)
    {
        var fileName = TryGetLeafFileName(displayName);
        if (string.IsNullOrWhiteSpace(fileName) || !fileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var normalized = StripBrowserDuplicateSuffix(fileName);
        return string.Equals(normalized, fileName, StringComparison.OrdinalIgnoreCase) ? null : normalized;
    }

    public static string GetPreferredStoredFileName(string displayName, LibretroDatRomEntry match) =>
        IsArcadeZipMatch(match, displayName)
            ? match.RomName
            : TryGetLeafFileName(displayName) ?? match.RomName;

    public static bool RejectCollisionForStoredFileName(string displayName, LibretroDatRomEntry match) =>
        IsArcadeZipMatch(match, displayName);

    public static bool IsArcadeSystem(string? systemName)
    {
        if (string.IsNullOrWhiteSpace(systemName))
        {
            return false;
        }

        return systemName.Contains("MAME", StringComparison.OrdinalIgnoreCase)
            || systemName.Contains("FBNEO", StringComparison.OrdinalIgnoreCase)
            || systemName.Contains("FINALBURN", StringComparison.OrdinalIgnoreCase)
            || systemName.Contains("ARCADE", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsTopLevelZip(string displayName) =>
        displayName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)
        && !displayName.Contains(':', StringComparison.Ordinal);

    private static string? TryGetLeafFileName(string displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return null;
        }

        var last = displayName;
        var idx = last.LastIndexOf(':');
        if (idx >= 0 && idx + 1 < last.Length)
        {
            last = last[(idx + 1)..];
        }

        last = last.Replace('\\', '/');
        var baseName = Path.GetFileName(last);
        return string.IsNullOrWhiteSpace(baseName) ? null : baseName.Trim();
    }

    private static string StripBrowserDuplicateSuffix(string fileName)
    {
        var ext = Path.GetExtension(fileName);
        var stem = Path.GetFileNameWithoutExtension(fileName);
        if (string.IsNullOrWhiteSpace(stem))
        {
            return fileName;
        }

        var match = BrowserDuplicateSuffixRegex().Match(stem);
        if (!match.Success)
        {
            return fileName;
        }

        var normalizedStem = match.Groups["stem"].Value.TrimEnd();
        return string.IsNullOrWhiteSpace(normalizedStem) ? fileName : normalizedStem + ext;
    }

    [GeneratedRegex(@"^(?<stem>.+?)\s*\((?<copy>\d+)\)$", RegexOptions.CultureInvariant)]
    private static partial Regex BrowserDuplicateSuffixRegex();
}
