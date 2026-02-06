using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Web;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record DownloadFromWebSourcePayload(int WebSourceId, string Url);

[BackgroundJobCommand("web.download")]
public sealed class DownloadFromWebSourceCommand(
    AppDbContext db,
    UploadStagingStore stagingStore,
    IInternalJobsClient internalJobs,
    IHttpClientFactory httpClientFactory) : IBackgroundJobCommand
{
    private const long MaxDownloadBytes = 8L * 1024 * 1024 * 1024; // 8 GiB

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<DownloadFromWebSourcePayload>(JobJson.Options);
        if (typed is null || typed.WebSourceId <= 0 || string.IsNullOrWhiteSpace(typed.Url))
        {
            throw new InvalidOperationException("web.download payload must include a webSourceId and url.");
        }

        var source = await db.WebSources.FirstOrDefaultAsync(s => s.Id == typed.WebSourceId, cancellationToken);
        if (source is null || !source.Enabled)
        {
            throw new InvalidOperationException("Web source not found or disabled.");
        }

        var indexUri = WebImportSafety.EnsureTrailingSlash(WebImportSafety.ParseAndValidateHttpUri(source.IndexUrl));
        await WebImportSafety.EnsureSafeRemoteAsync(indexUri, cancellationToken);

        var uri = WebImportSafety.ParseAndValidateHttpUri(typed.Url);

        // Only allow same-host downloads as the configured index.
        if (!string.Equals(uri.Host, indexUri.Host, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Download host does not match the configured web source.");
        }

        await WebImportSafety.EnsureSafeRemoteAsync(uri, cancellationToken);

        var stagingDir = stagingStore.CreateStagingDirectory();
        var fileName = MakeSafeFileName(TryGetFileNameFromUrl(uri) ?? "download");
        var destPath = EnsureUnique(Path.Combine(stagingDir, fileName));

        await context.SetProgressPermilleAsync(0, cancellationToken);

        var client = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
        request.Headers.Accept.ParseAdd("*/*");
        request.Headers.AcceptLanguage.ParseAdd("en-US,en;q=0.9");

        await context.LogInfoAsync($"Downloading: {uri}", cancellationToken);

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        var contentLength = response.Content.Headers.ContentLength;
        if (contentLength is not null && contentLength.Value > MaxDownloadBytes)
        {
            throw new InvalidOperationException($"Remote file is too large ({contentLength.Value} bytes).");
        }

        long total = 0;
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = File.Create(destPath);

        var buffer = new byte[1024 * 128];
        while (true)
        {
            var read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > MaxDownloadBytes)
            {
                throw new InvalidOperationException($"Download exceeded max size ({MaxDownloadBytes} bytes).");
            }

            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);

            if (contentLength is not null && contentLength.Value > 0)
            {
                var permille = (int)Math.Clamp((total * 800L) / contentLength.Value, 0, 800);
                await context.SetProgressPermilleAsync(permille, cancellationToken);
            }
        }

        await output.FlushAsync(cancellationToken);
        await context.SetProgressPermilleAsync(800, cancellationToken);

        var importJobId = await internalJobs.EnqueueUploadImportAsync(stagingDir, cancellationToken);
        context.Logger.LogInformation("web.download enqueued upload.import job {ImportJobId} for {Dest}", importJobId, destPath);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
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

    private static string EnsureUnique(string destPath)
    {
        if (!File.Exists(destPath))
        {
            return destPath;
        }

        var dir = Path.GetDirectoryName(destPath)!;
        var baseName = Path.GetFileNameWithoutExtension(destPath);
        var ext = Path.GetExtension(destPath);

        for (var i = 2; i < 10_000; i++)
        {
            var candidate = Path.Combine(dir, $"{baseName} ({i}){ext}");
            if (!File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new IOException("Unable to create a unique filename for web download staging.");
    }

    private static string MakeSafeFileName(string fileName)
    {
        var name = Path.GetFileName(fileName);
        if (string.IsNullOrWhiteSpace(name))
        {
            name = "download";
        }

        var sb = new StringBuilder(name.Length);
        foreach (var ch in name)
        {
            sb.Append(ch switch
            {
                '/' or '\\' => '_',
                ':' or '*' or '?' or '"' or '<' or '>' or '|' => '_',
                _ => ch
            });
        }

        return sb.ToString().Trim();
    }
}
