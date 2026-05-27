using Microsoft.Extensions.Logging;

namespace games_vault.Libretro.Dat;

public sealed class LibretroDatIndexBuilder(
    LibretroDatabaseStore store,
    LibretroDatParser parser,
    ILogger<LibretroDatIndexBuilder> logger)
{
    public LibretroDatIndex BuildFromDisk()
    {
        var map = new Dictionary<string, (LibretroDatRomEntry Entry, int Score)>(StringComparer.OrdinalIgnoreCase);

        // libretro-database precedence: dat overrides metadat.
        var paths = new[]
        {
            store.GetMetaDatDirectoryPath(),
            store.GetDatDirectoryPath()
        };

        foreach (var root in paths)
        {
            if (!Directory.Exists(root))
            {
                continue;
            }

            foreach (var datPath in Directory.EnumerateFiles(root, "*.dat", SearchOption.AllDirectories))
            {
                if (ShouldSkipDat(datPath))
                {
                    continue;
                }

                try
                {
                    var content = File.ReadAllText(datPath);
                    var (_, entries) = parser.Parse(content);

                    foreach (var entry in entries)
                    {
                        var score = Score(entry, datPath);

                        if (!map.TryGetValue(entry.Crc32, out var existing) || score >= existing.Score)
                        {
                            map[entry.Crc32] = (entry, score);
                        }
                    }
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Failed parsing DAT {DatPath}", datPath);
                }
            }
        }

        return new LibretroDatIndex(map.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.Entry, StringComparer.OrdinalIgnoreCase));
    }

    private static int Score(LibretroDatRomEntry entry, string datPath)
    {
        // Some metadat/*.dat files only contain CRCs (no game/rom names). Prefer the richest source.
        var score = 0;

        var normalizedPath = datPath.Replace('\\', '/');
        if (normalizedPath.Contains("/metadat/no-intro/", StringComparison.OrdinalIgnoreCase))
        {
            score += 100;
        }

        if (normalizedPath.Contains("/dat/", StringComparison.OrdinalIgnoreCase))
        {
            score += 50;
        }

        if (!string.IsNullOrWhiteSpace(entry.RomName) && !string.Equals(entry.RomName, "rom", StringComparison.OrdinalIgnoreCase))
        {
            score += 10;
        }

        if (!string.IsNullOrWhiteSpace(entry.GameName) &&
            !string.Equals(entry.GameName, "Unknown", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(entry.GameName, "rom", StringComparison.OrdinalIgnoreCase))
        {
            score += 10;
        }

        if (entry.DeclaredSizeBytes is > 0)
        {
            score += 1;
        }

        return score;
    }

    private static bool ShouldSkipDat(string datPath)
    {
        var normalizedPath = datPath.Replace('\\', '/');
        return normalizedPath.Contains("/metadat/mame-member/", StringComparison.OrdinalIgnoreCase);
    }
}
