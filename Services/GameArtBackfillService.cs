using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Services;

public sealed record GameArtBackfillResult(int Scanned, int Updated, int Skipped, int NotFound, int Failed);

public sealed class GameArtBackfillService(
    AppDbContext db,
    IHttpClientFactory httpClientFactory,
    IWebHostEnvironment env,
    ILogger<GameArtBackfillService> logger)
{
    private const string ProviderName = "libretro-thumbnails";
    private const string RawBaseUrl = "https://raw.githubusercontent.com/libretro-thumbnails";
    private static readonly TimeSpan FailedRetryDelay = TimeSpan.FromDays(7);

    public async Task<GameArtBackfillResult> BackfillAsync(bool force = false, int limit = 100, CancellationToken cancellationToken = default)
    {
        limit = Math.Clamp(limit, 1, 500);
        var cutoff = DateTime.UtcNow - FailedRetryDelay;

        var candidates = await db.Games
            .OrderBy(x => x.Id)
            .Where(x => force || string.IsNullOrWhiteSpace(x.CoverImagePath) || string.IsNullOrWhiteSpace(x.ScreenshotImagePath))
            .Where(x => force || x.LastGameArtLookupUtc == null || x.LastGameArtLookupUtc < cutoff || x.GameArtStatus == "found")
            .Take(limit)
            .ToListAsync(cancellationToken);

        var result = new MutableResult();
        var client = httpClientFactory.CreateClient(nameof(GameArtBackfillService));
        client.Timeout = TimeSpan.FromSeconds(12);

        foreach (var game in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            result.Scanned++;

            if (!force && !string.IsNullOrWhiteSpace(game.CoverImagePath) && !string.IsNullOrWhiteSpace(game.ScreenshotImagePath))
            {
                result.Skipped++;
                continue;
            }

            try
            {
                var updated = false;
                var anyFound = false;

                if (force || string.IsNullOrWhiteSpace(game.CoverImagePath))
                {
                    var cover = await TryDownloadAsync(client, game, "Named_Boxarts", "cover.png", cancellationToken);
                    if (cover is not null)
                    {
                        game.CoverImagePath = cover;
                        updated = true;
                        anyFound = true;
                    }
                }

                if (force || string.IsNullOrWhiteSpace(game.ScreenshotImagePath))
                {
                    var snap = await TryDownloadAsync(client, game, "Named_Snaps", "screenshot.png", cancellationToken);
                    if (snap is not null)
                    {
                        game.ScreenshotImagePath = snap;
                        updated = true;
                        anyFound = true;
                    }
                }

                game.GameArtProvider = ProviderName;
                game.LastGameArtLookupUtc = DateTime.UtcNow;
                game.GameArtError = null;
                game.GameArtStatus = anyFound || HasAnyArt(game) ? "found" : "not_found";

                if (updated)
                {
                    result.Updated++;
                }
                else if (!HasAnyArt(game))
                {
                    result.NotFound++;
                }
                else
                {
                    result.Skipped++;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Game art backfill failed for game {GameId} {GameName}", game.Id, game.Name);
                game.GameArtProvider = ProviderName;
                game.GameArtStatus = "error";
                game.GameArtError = ex.Message.Length > 512 ? ex.Message[..512] : ex.Message;
                game.LastGameArtLookupUtc = DateTime.UtcNow;
                result.Failed++;
            }

            await db.SaveChangesAsync(cancellationToken);
            await Task.Delay(100, cancellationToken);
        }

        return result.ToResult();
    }

    private async Task<string?> TryDownloadAsync(HttpClient client, Game game, string libretroFolder, string fileName, CancellationToken cancellationToken)
    {
        var url = BuildLibretroThumbnailUrl(game.SystemName, libretroFolder, game.Name);
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (contentType is not null && !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var webRootPath = string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath;
        var relativeDirectory = $"art/games/{game.Id}";
        var absoluteDirectory = Path.Combine(webRootPath, "art", "games", game.Id.ToString());
        Directory.CreateDirectory(absoluteDirectory);

        var absolutePath = Path.Combine(absoluteDirectory, fileName);
        await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
        await using (var output = File.Create(absolutePath))
        {
            await input.CopyToAsync(output, cancellationToken);
        }

        return "/" + relativeDirectory + "/" + fileName;
    }

    private static string BuildLibretroThumbnailUrl(string systemName, string folder, string gameName)
    {
        static string FileSegment(string value) => Uri.EscapeDataString(value);
        var repositoryName = systemName.Trim().Replace(" ", "_", StringComparison.Ordinal);
        return $"{RawBaseUrl}/{repositoryName}/master/{FileSegment(folder)}/{FileSegment(gameName)}.png";
    }

    private static bool HasAnyArt(Game game) =>
        !string.IsNullOrWhiteSpace(game.CoverImagePath) || !string.IsNullOrWhiteSpace(game.ScreenshotImagePath);

    private sealed class MutableResult
    {
        public int Scanned { get; set; }
        public int Updated { get; set; }
        public int Skipped { get; set; }
        public int NotFound { get; set; }
        public int Failed { get; set; }

        public GameArtBackfillResult ToResult() => new(Scanned, Updated, Skipped, NotFound, Failed);
    }
}
