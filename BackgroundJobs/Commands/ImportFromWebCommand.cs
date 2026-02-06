using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using games_vault.Libretro.Import;
using games_vault.Web;

namespace games_vault.BackgroundJobs.Commands;

public sealed record WebImportPayload(string Url, string? FileName);

[BackgroundJobCommand("web.import")]
public sealed class ImportFromWebCommand(
    IHttpClientFactory httpClientFactory,
    GameUploadImporter importer,
    UploadStagingStore stagingStore) : IBackgroundJobCommand
{
    private const long MaxDownloadBytes = 8L * 1024 * 1024 * 1024; // 8 GiB

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<WebImportPayload>(JobJson.Options);
        if (typed is null || string.IsNullOrWhiteSpace(typed.Url))
        {
            throw new InvalidOperationException("web.import payload must include a URL.");
        }

        var url = typed.Url.Trim();
        var fileName = string.IsNullOrWhiteSpace(typed.FileName) ? null : typed.FileName.Trim();

        var uri = WebImportSafety.ParseAndValidateHttpUri(url);
        await WebImportSafety.EnsureSafeRemoteAsync(uri, cancellationToken);

        var stagingDir = stagingStore.CreateStagingDirectory();
        var succeeded = false;

        try
        {
            await context.SetProgressPermilleAsync(0, cancellationToken);

            var downloadedPath = await DownloadToStagingAsync(uri, fileName, stagingDir, context, cancellationToken);

            await context.LogInfoAsync($"Downloaded to staging: {Path.GetFileName(downloadedPath)}", cancellationToken);

            var result = await importer.ImportFromStagedDirectoryAsync(stagingDir, context, cancellationToken);

            context.Logger.LogInformation("web.import done: scanned={Scanned} matched={Matched} games={Games}",
                result.TotalScannedFileCount, result.TotalMatchedFileCount, result.Groups.Count);

            await context.SetProgressPermilleAsync(1000, cancellationToken);
            succeeded = true;
        }
        finally
        {
            // Keep staging on failure so the job can be re-run/debugged.
            if (succeeded)
            {
                stagingStore.TryDeleteDirectory(stagingDir);
            }
        }
    }

    private async Task<string> DownloadToStagingAsync(
        Uri uri,
        string? fileName,
        string stagingDir,
        BackgroundJobExecutionContext context,
        CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("games-vault", "1.0"));

        await context.LogInfoAsync($"Downloading: {uri}", cancellationToken);

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        var contentLength = response.Content.Headers.ContentLength;
        if (contentLength is not null && contentLength.Value > MaxDownloadBytes)
        {
            throw new InvalidOperationException($"Remote file is too large ({contentLength.Value} bytes).");
        }

        var name = MakeSafeFileName(
            fileName
            ?? TryGetFileNameFromContentDisposition(response.Content.Headers.ContentDisposition)
            ?? TryGetFileNameFromUrl(uri)
            ?? "download");

        var destPath = EnsureUnique(Path.Combine(stagingDir, name));

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
                // Map download to the first half of the job.
                var permille = (int)Math.Clamp((total * 500L) / contentLength.Value, 0, 500);
                await context.SetProgressPermilleAsync(permille, cancellationToken);
            }
        }

        await output.FlushAsync(cancellationToken);
        await context.LogInfoAsync($"Downloaded {total} bytes.", cancellationToken);

        return destPath;
    }

    private static string? TryGetFileNameFromContentDisposition(ContentDispositionHeaderValue? cd)
    {
        var name = cd?.FileNameStar ?? cd?.FileName;
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        name = name.Trim().Trim('"');
        return string.IsNullOrWhiteSpace(name) ? null : name;
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

        throw new IOException("Unable to create a unique filename for web import staging.");
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

    // Safety logic shared in games_vault.Web.WebImportSafety
}
