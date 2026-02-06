using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using games_vault.Data;
using games_vault.Models;
using games_vault.Web;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record ScanWebSourcePayload(int WebSourceId, Guid SessionId, string? Query = null, int MaxResults = 2000);

[BackgroundJobCommand("web.scan")]
public sealed class ScanWebSourceCommand(
    AppDbContext db,
    IHttpClientFactory httpClientFactory) : IBackgroundJobCommand
{
    private const int MaxIndexBytes = 10 * 1024 * 1024; // 10 MiB

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<ScanWebSourcePayload>(JobJson.Options);
        if (typed is null || typed.WebSourceId <= 0)
        {
            throw new InvalidOperationException("web.scan payload must include a webSourceId.");
        }

        var source = await db.WebSources.FirstOrDefaultAsync(s => s.Id == typed.WebSourceId, cancellationToken);
        if (source is null || !source.Enabled)
        {
            throw new InvalidOperationException("Web source not found or disabled.");
        }

        var run = await db.WebScanRuns.FirstOrDefaultAsync(r => r.BackgroundJobId == context.Job.Id, cancellationToken);
        if (run is null)
        {
            run = new WebScanRun
            {
                WebSourceId = source.Id,
                BackgroundJobId = context.Job.Id,
                SessionId = typed.SessionId,
                Status = WebScanStatus.Running,
                CreatedUtc = DateTime.UtcNow
            };
            db.WebScanRuns.Add(run);
            await db.SaveChangesAsync(cancellationToken);
        }
        else
        {
            run.Status = WebScanStatus.Running;
            await db.SaveChangesAsync(cancellationToken);
        }

        var existing = await db.WebScanResults
            .Where(x => x.WebScanRun.SessionId == typed.SessionId)
            .ExecuteDeleteAsync(cancellationToken);

        context.Logger.LogInformation("web.scan started: source={WebSourceId} url={Url} cleared={Cleared}", source.Id, source.IndexUrl, existing);

        var indexUri = WebImportSafety.EnsureTrailingSlash(WebImportSafety.ParseAndValidateHttpUri(source.IndexUrl));
        await WebImportSafety.EnsureSafeRemoteAsync(indexUri, cancellationToken);

        var q = string.IsNullOrWhiteSpace(typed.Query) ? null : typed.Query.Trim().ToLowerInvariant();
        var max = Math.Clamp(typed.MaxResults, 1, 50_000);
        var allowedExts = ParseAllowedExtensions(source.AllowedExtensions);

        try
        {
            await context.SetProgressPermilleAsync(0, cancellationToken);
            var html = await DownloadIndexHtmlAsync(indexUri, context, cancellationToken);
            await context.SetProgressPermilleAsync(150, cancellationToken);

            var results = new List<WebScanResult>(capacity: 512);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var count = 0;
            var totalHrefs = 0;
            var skippedNonHttp = 0;
            var skippedCrossHost = 0;
            var skippedNoFileName = 0;
            var skippedQuery = 0;
            var skippedExt = 0;
            var skippedDup = 0;

            foreach (var href in HtmlIndexLinkExtractor.ExtractHrefs(html))
            {
                cancellationToken.ThrowIfCancellationRequested();
                totalHrefs++;

                if (href.StartsWith("#", StringComparison.Ordinal) ||
                    href.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase) ||
                    href.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                // Avoid "directory" links like ".../" which aren't downloadable files.
                if (href.EndsWith("/", StringComparison.Ordinal))
                {
                    skippedNoFileName++;
                    continue;
                }

                Uri link;
                try
                {
                    link = new Uri(indexUri, href);
                }
                catch
                {
                    continue;
                }

                if (!string.Equals(link.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(link.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
                {
                    skippedNonHttp++;
                    continue;
                }

                // Only allow same-host links as the configured index.
                if (!string.Equals(link.Host, indexUri.Host, StringComparison.OrdinalIgnoreCase))
                {
                    skippedCrossHost++;
                    continue;
                }

                // Normalize and validate basic safety requirements.
                var linkNormalized = WebImportSafety.ParseAndValidateHttpUri(link.ToString());
                if (!string.Equals(linkNormalized.Host, indexUri.Host, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var fileName = TryGetFileNameFromUrl(linkNormalized);
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    skippedNoFileName++;
                    continue;
                }

                if (q is not null && !fileName.ToLowerInvariant().Contains(q))
                {
                    skippedQuery++;
                    continue;
                }

                if (allowedExts.Count > 0)
                {
                    var ext = Path.GetExtension(fileName);
                    if (string.IsNullOrWhiteSpace(ext) || !allowedExts.Contains(ext))
                    {
                        skippedExt++;
                        continue;
                    }
                }

                var url = linkNormalized.ToString();
                if (!seen.Add(url))
                {
                    skippedDup++;
                    continue;
                }

                results.Add(new WebScanResult
                {
                    WebScanRunId = run.Id,
                    Url = url.Length > 1000 ? url[^1000..] : url,
                    FileName = fileName.Length > 260 ? fileName[^260..] : fileName,
                    CreatedUtc = DateTime.UtcNow
                });

                count++;
                if (results.Count >= 500)
                {
                    db.WebScanResults.AddRange(results);
                    await db.SaveChangesAsync(cancellationToken);
                    results.Clear();
                    await context.SetProgressPermilleAsync(Math.Min(950, 150 + count * 850 / max), cancellationToken);
                    await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
                }

                if (count >= max)
                {
                    break;
                }
            }

            await context.LogInfoAsync(
                $"Index parse: hrefs={totalHrefs} kept={count} skipped(nonHttp={skippedNonHttp}, crossHost={skippedCrossHost}, noFile={skippedNoFileName}, query={skippedQuery}, ext={skippedExt}, dup={skippedDup})",
                cancellationToken);

            if (results.Count > 0)
            {
                db.WebScanResults.AddRange(results);
                await db.SaveChangesAsync(cancellationToken);
            }

            run.LinkCount = count;
            run.Status = WebScanStatus.Succeeded;
            run.CompletedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(cancellationToken);

            await context.SetProgressPermilleAsync(1000, cancellationToken);
        }
        catch
        {
            run.Status = WebScanStatus.Failed;
            run.CompletedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(cancellationToken);
            throw;
        }
    }

    private async Task<string> DownloadIndexHtmlAsync(Uri indexUri, BackgroundJobExecutionContext context, CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, indexUri);
        request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
        request.Headers.Accept.ParseAdd("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        request.Headers.AcceptLanguage.ParseAdd("en-US,en;q=0.9");
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };

        await context.LogInfoAsync($"Fetching index: {indexUri}", cancellationToken);

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        var finalUri = response.RequestMessage?.RequestUri;
        var ct = response.Content.Headers.ContentType?.ToString() ?? "(unknown)";
        await context.LogInfoAsync($"Index response: {(int)response.StatusCode} {response.ReasonPhrase} content-type={ct} url={(finalUri?.ToString() ?? indexUri.ToString())}", cancellationToken);

        var len = response.Content.Headers.ContentLength;
        if (len is not null && len.Value > MaxIndexBytes)
        {
            throw new InvalidOperationException($"Index page is too large ({len.Value} bytes).");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var ms = new MemoryStream();
        var buffer = new byte[64 * 1024];
        var total = 0;

        while (true)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > MaxIndexBytes)
            {
                throw new InvalidOperationException($"Index page exceeded max size ({MaxIndexBytes} bytes).");
            }

            ms.Write(buffer, 0, read);
        }

        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private static string? TryGetFileNameFromUrl(Uri uri)
    {
        var segment = uri.Segments.LastOrDefault();
        if (string.IsNullOrWhiteSpace(segment))
        {
            return null;
        }

        var name = Uri.UnescapeDataString(segment.Trim('/'));
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    private static HashSet<string> ParseAllowedExtensions(string? raw)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return set;
        }

        var parts = raw
            .Split([',', ';', '\n', '\r', '\t', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        foreach (var p in parts)
        {
            var ext = p.StartsWith('.') ? p : "." + p;
            if (ext.Length <= 1 || ext.Length > 20)
            {
                continue;
            }

            set.Add(ext);
        }

        return set;
    }
}
