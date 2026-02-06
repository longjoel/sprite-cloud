using System.Text.RegularExpressions;

namespace games_vault.Libretro.Dat;

public sealed record SystemDatRom(
    string SystemGroup,
    string RelativePath,
    string Crc32,
    long? DeclaredSizeBytes);

public sealed class SystemDatIndex
{
    public required IReadOnlyDictionary<string, SystemDatRom> ByCrc32 { get; init; }
    public required IReadOnlyDictionary<string, SystemDatRom> ByPath { get; init; }
    public required IReadOnlyDictionary<string, IReadOnlyList<SystemDatRom>> BySystemGroup { get; init; }

    public static SystemDatIndex Parse(string datContent)
    {
        if (string.IsNullOrWhiteSpace(datContent))
        {
            return new SystemDatIndex
            {
                ByCrc32 = new Dictionary<string, SystemDatRom>(),
                ByPath = new Dictionary<string, SystemDatRom>(),
                BySystemGroup = new Dictionary<string, IReadOnlyList<SystemDatRom>>()
            };
        }

        var byCrc = new Dictionary<string, SystemDatRom>(StringComparer.OrdinalIgnoreCase);
        var byPath = new Dictionary<string, SystemDatRom>(StringComparer.OrdinalIgnoreCase);
        var byGroup = new Dictionary<string, List<SystemDatRom>>(StringComparer.OrdinalIgnoreCase);

        // We only need comment group -> rom lines with name/crc/size.
        var commentRegex = new Regex("^\\s*comment\\s+\"(?<c>[^\"]+)\"\\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        var romNameRegex = new Regex("\\brom\\s*\\(\\s*name\\s+\"(?<name>[^\"]+)\"\\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        var romNameBareRegex = new Regex("\\brom\\s*\\(\\s*name\\s+(?<name>[^\\s\\)]+)\\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        var romCrcRegex = new Regex("\\bcrc\\s+(?<crc>[0-9a-fA-F]{8})\\b", RegexOptions.Compiled);
        var romSizeRegex = new Regex("\\bsize\\s+(?<size>\\d+)\\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        var currentGroup = "Unknown";
        foreach (var rawLine in datContent.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');

            var cm = commentRegex.Match(line);
            if (cm.Success)
            {
                currentGroup = cm.Groups["c"].Value.Trim();
                if (string.IsNullOrWhiteSpace(currentGroup))
                {
                    currentGroup = "Unknown";
                }
                continue;
            }

            // rom lines can be quoted or bare
            var rm = romNameRegex.Match(line);
            if (!rm.Success)
            {
                rm = romNameBareRegex.Match(line);
            }

            if (!rm.Success)
            {
                continue;
            }

            var crcMatch = romCrcRegex.Match(line);
            if (!crcMatch.Success)
            {
                continue;
            }

            var crc = crcMatch.Groups["crc"].Value.Trim().ToUpperInvariant();
            var romName = rm.Groups["name"].Value.Trim();
            if (string.IsNullOrWhiteSpace(romName))
            {
                continue;
            }

            var relPath = NormalizeRelativePath(romName);
            if (relPath is null)
            {
                continue;
            }

            long? size = null;
            var sizeMatch = romSizeRegex.Match(line);
            if (sizeMatch.Success && long.TryParse(sizeMatch.Groups["size"].Value, out var parsedSize))
            {
                size = parsedSize;
            }

            var entry = new SystemDatRom(currentGroup, relPath, crc, size);

            // Prefer the first entry seen for a CRC, but still allow lookup by path.
            byCrc.TryAdd(crc, entry);
            byPath.TryAdd(relPath, entry);

            if (!byGroup.TryGetValue(currentGroup, out var list))
            {
                list = new List<SystemDatRom>();
                byGroup[currentGroup] = list;
            }
            list.Add(entry);
        }

        return new SystemDatIndex
        {
            ByCrc32 = byCrc,
            ByPath = byPath,
            BySystemGroup = byGroup.ToDictionary(k => k.Key, v => (IReadOnlyList<SystemDatRom>)v.Value, StringComparer.OrdinalIgnoreCase)
        };
    }

    public static string? NormalizeRelativePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        path = path.Trim().Replace('\\', '/');

        while (path.StartsWith("/"))
        {
            path = path[1..];
        }

        // Disallow traversal.
        if (path.Contains("..", StringComparison.Ordinal))
        {
            return null;
        }

        // Remove any duplicate slashes.
        while (path.Contains("//", StringComparison.Ordinal))
        {
            path = path.Replace("//", "/", StringComparison.Ordinal);
        }

        return string.IsNullOrWhiteSpace(path) ? null : path;
    }
}
