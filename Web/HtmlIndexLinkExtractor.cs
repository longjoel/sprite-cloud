using System.Text.RegularExpressions;

namespace games_vault.Web;

public static class HtmlIndexLinkExtractor
{
    // Not a full HTML parser; intended for "directory listing" style index pages.
    private static readonly Regex HrefRegex = new(
        "href\\s*=\\s*(?:\"(?<u>[^\"]+)\"|'(?<u>[^']+)'|(?<u>[^\\s>]+))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static IEnumerable<string> ExtractHrefs(string html)
    {
        if (string.IsNullOrEmpty(html))
        {
            yield break;
        }

        foreach (Match m in HrefRegex.Matches(html))
        {
            var u = m.Groups["u"].Value;
            if (string.IsNullOrWhiteSpace(u))
            {
                continue;
            }

            yield return u.Trim();
        }
    }
}

