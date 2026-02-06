using System.Text.RegularExpressions;

namespace games_vault.Libretro.Dat;

public sealed partial class LibretroDatParser
{
    private static readonly Regex HeaderNameRegex = new(@"^\s*name\s+""(?<name>[^""]+)""\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex GameNameLineRegex = new(@"^\s*name\s+""(?<name>[^""]+)""\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.Multiline);
    private static readonly Regex GameDescriptionLineRegex = new(@"^\s*description\s+""(?<name>[^""]+)""\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.Multiline);
    private static readonly Regex NameRegex = new(@"\bname\s+""(?<name>[^""]+)""", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex DescriptionRegex = new(@"\bdescription\s+""(?<name>[^""]+)""", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex RomCrcRegex = new(@"\bcrc\s+(?<crc>[0-9a-fA-F]{8})\b", RegexOptions.Compiled);
    private static readonly Regex RomSizeRegex = new(@"\bsize\s+(?<size>\d+)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex RomNameRegex = new(@"\brom\s*\(\s*name\s+""(?<name>[^""]+)""", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public (string? SystemName, List<LibretroDatRomEntry> Entries) Parse(string datContent)
    {
        // Best-effort parsing of clrmamepro DAT files used in libretro-database.
        // We only need system name + rom blocks with CRCs for matching imports.
        var systemName = TryParseHeaderSystemName(datContent);
        var entries = new List<LibretroDatRomEntry>();

        foreach (var gameBlock in ExtractBlocks(datContent, "game"))
        {
            string? firstRomName = null;

            var gameName =
                TryMatchGroup(GameDescriptionLineRegex, gameBlock, "name") ??
                TryMatchGroup(GameNameLineRegex, gameBlock, "name") ??
                TryMatchString(DescriptionRegex, gameBlock) ??
                TryMatchString(NameRegex, gameBlock);

            foreach (var romBlock in ExtractBlocks(gameBlock, "rom"))
            {
                var crc = TryMatchGroup(RomCrcRegex, romBlock, "crc");
                if (string.IsNullOrWhiteSpace(crc))
                {
                    continue;
                }

                var romName = TryMatchString(NameRegex, romBlock) ?? "rom";
                firstRomName ??= romName;
                var size = TryMatchLong(RomSizeRegex, romBlock);

                entries.Add(new LibretroDatRomEntry(
                    systemName ?? "Unknown",
                    gameName ?? DeriveGameNameFromRom(firstRomName) ?? "Unknown",
                    romName,
                    LibretroDatIndex.NormalizeCrc32(crc),
                    size));
            }
        }

        return (systemName, entries);
    }

    private static string? TryParseHeaderSystemName(string datContent)
    {
        // Header is usually: clrmamepro ( name "..." ... )
        foreach (var header in ExtractBlocks(datContent, "clrmamepro"))
        {
            foreach (var line in header.Split('\n'))
            {
                var m = HeaderNameRegex.Match(line);
                if (m.Success)
                {
                    return m.Groups["name"].Value.Trim();
                }
            }
        }

        return null;
    }

    private static string? TryMatchString(Regex regex, string text)
    {
        return TryMatchGroup(regex, text, "name");
    }

    private static string? TryMatchGroup(Regex regex, string text, string groupName)
    {
        var m = regex.Match(text);
        return m.Success ? m.Groups[groupName].Value.Trim() : null;
    }

    private static string? DeriveGameNameFromRom(string? romName)
    {
        if (string.IsNullOrWhiteSpace(romName))
        {
            return null;
        }

        var fileName = Path.GetFileName(romName.Trim());
        var withoutExt = Path.GetFileNameWithoutExtension(fileName);
        return string.IsNullOrWhiteSpace(withoutExt) ? null : withoutExt;
    }

    private static long? TryMatchLong(Regex regex, string text)
    {
        var m = regex.Match(text);
        if (!m.Success)
        {
            return null;
        }

        return long.TryParse(m.Groups["size"].Value, out var value) ? value : null;
    }

    private static IEnumerable<string> ExtractBlocks(string content, string keyword)
    {
        var idx = 0;
        while (idx < content.Length)
        {
            idx = IndexOfKeywordThenParen(content, keyword, idx, out var openParenIndex);
            if (idx < 0)
            {
                yield break;
            }

            var end = FindMatchingParen(content, openParenIndex);
            if (end < 0)
            {
                yield break;
            }

            yield return content.Substring(openParenIndex + 1, end - openParenIndex - 1);
            idx = end + 1;
        }
    }

    private static int IndexOfKeywordThenParen(string text, string keyword, int startIndex, out int openParenIndex)
    {
        openParenIndex = -1;

        for (var i = startIndex; i <= text.Length - keyword.Length; i++)
        {
            if (!IsWordBoundary(text, i))
            {
                continue;
            }

            if (!text.AsSpan(i, keyword.Length).Equals(keyword, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var after = i + keyword.Length;
            if (after < text.Length && char.IsLetterOrDigit(text[after]))
            {
                continue;
            }

            // Skip whitespace to '('
            var j = after;
            while (j < text.Length && char.IsWhiteSpace(text[j]))
            {
                j++;
            }

            if (j < text.Length && text[j] == '(')
            {
                openParenIndex = j;
                return i;
            }
        }

        return -1;
    }

    private static bool IsWordBoundary(string text, int index)
    {
        if (index <= 0)
        {
            return true;
        }

        return !char.IsLetterOrDigit(text[index - 1]) && text[index - 1] != '_';
    }

    private static int FindMatchingParen(string text, int openParenIndex)
    {
        var depth = 0;
        var inString = false;

        for (var i = openParenIndex; i < text.Length; i++)
        {
            var c = text[i];

            if (c == '"')
            {
                // clrmamepro DATs generally don't escape quotes; keep it simple.
                inString = !inString;
                continue;
            }

            if (inString)
            {
                continue;
            }

            if (c == '(')
            {
                depth++;
            }
            else if (c == ')')
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }
        }

        return -1;
    }
}
