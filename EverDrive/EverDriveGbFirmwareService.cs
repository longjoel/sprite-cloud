using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace games_vault.EverDrive;

public sealed record EverDriveGbFirmwareOption(string Label, string Url);

public sealed class EverDriveGbFirmwareService(
    IHttpClientFactory httpClientFactory,
    IMemoryCache cache,
    ILogger<EverDriveGbFirmwareService> logger)
{
    private const string CacheKey = "everdrive-gb:firmware-options";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    // These are directory indexes; we scrape for .zip files.
    private static readonly string[] FirmwareIndexUrls =
    [
        "https://krikzz.com/pub/support/everdrive-gb/x-series/OS/",
        "https://krikzz.com/pub/support/everdrive-gb/original-series/OS/"
    ];

    public async Task<IReadOnlyList<EverDriveGbFirmwareOption>> GetOptionsAsync(CancellationToken cancellationToken)
    {
        if (cache.TryGetValue(CacheKey, out IReadOnlyList<EverDriveGbFirmwareOption>? cached) && cached is not null)
        {
            return cached;
        }

        var options = new List<EverDriveGbFirmwareOption>();
        foreach (var indexUrl in FirmwareIndexUrls)
        {
            try
            {
                options.AddRange(await ScrapeIndexAsync(indexUrl, cancellationToken));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to load EverDrive GB firmware index {Url}", indexUrl);
            }
        }

        options = options
            .DistinctBy(x => x.Url, StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(x => ExtractVersionKey(x.Label))
            .ThenByDescending(x => x.Label)
            .Take(50)
            .ToList();

        cache.Set(CacheKey, options, CacheTtl);
        return options;
    }

    public async Task<EverDriveGbFirmwareOption?> GetLatestAsync(CancellationToken cancellationToken)
    {
        var options = await GetOptionsAsync(cancellationToken);
        return options.FirstOrDefault();
    }

    private async Task<IReadOnlyList<EverDriveGbFirmwareOption>> ScrapeIndexAsync(string indexUrl, CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.UserAgent.ParseAdd("games-vault/1.0");

        var html = await client.GetStringAsync(indexUrl, cancellationToken);

        // Extract href targets.
        var hrefs = Regex.Matches(html, "href\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase)
            .Select(m => m.Groups[1].Value)
            .Where(h => h.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            .ToList();

        var options = new List<EverDriveGbFirmwareOption>();
        foreach (var href in hrefs)
        {
            var url = href.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? href
                : new Uri(new Uri(indexUrl), href).ToString();

            var file = Path.GetFileName(new Uri(url).AbsolutePath);
            var label = $"{file} ({new Uri(indexUrl).AbsolutePath.TrimEnd('/')})";
            options.Add(new EverDriveGbFirmwareOption(label, url));
        }

        return options;
    }

    private static Version ExtractVersionKey(string label)
    {
        // Best effort: pick the highest version-ish token in the string.
        var matches = Regex.Matches(label, "(\\d+)(?:\\.(\\d+))+(?:\\.(\\d+))?");
        Version best = new(0, 0);
        foreach (Match m in matches)
        {
            if (Version.TryParse(m.Value, out var v) && v > best)
            {
                best = v;
            }
        }
        return best;
    }
}

