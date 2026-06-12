using System.Text.Json;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed class GameArtBackfillCommand(
    IServiceScopeFactory scopeFactory,
    IHttpClientFactory httpClientFactory,
    IWebHostEnvironment env) : IBackgroundJobCommand
{
    private const string ProviderName = "libretro-thumbnails";
    private const string RawBaseUrl = "https://raw.githubusercontent.com/libretro-thumbnails";
    private static readonly TimeSpan FailedRetryDelay = TimeSpan.FromDays(7);

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var jobPayload = JsonSerializer.Deserialize<GameArtBackfillPayload>(payload.GetRawText(), JobJson.Options);
        if (jobPayload is null)
        {
            await context.LogErrorAsync("Invalid payload: expected { Force, Limit, GameId }", cancellationToken);
            return;
        }

        var limit = Math.Clamp(jobPayload.Limit, 1, 500);
        var cutoff = DateTime.UtcNow - FailedRetryDelay;

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        IQueryable<Game> query = db.Games;

        if (jobPayload.GameId is int specificGameId)
        {
            query = query.Where(x => x.Id == specificGameId);
        }
        else
        {
            query = query
                .OrderBy(x => x.Id)
                .Where(x => jobPayload.Force
                    || string.IsNullOrWhiteSpace(x.CoverImagePath)
                    || string.IsNullOrWhiteSpace(x.ScreenshotImagePath))
                .Where(x => jobPayload.Force
                    || x.LastGameArtLookupUtc == null
                    || x.LastGameArtLookupUtc < cutoff
                    || x.GameArtStatus == "found");
        }

        var candidates = await query.Take(limit).ToListAsync(cancellationToken);

        await context.LogInfoAsync($"Art backfill starting: {candidates.Count} candidate(s), force={jobPayload.Force}, limit={limit}" +
            (jobPayload.GameId is not null ? $", gameId={jobPayload.GameId}" : ""), cancellationToken);

        var scanned = 0;
        var updated = 0;
        var skipped = 0;
        var notFound = 0;
        var failed = 0;

        var client = httpClientFactory.CreateClient("GameArtBackfill");
        client.Timeout = TimeSpan.FromSeconds(12);

        foreach (var game in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            scanned++;

            if (!jobPayload.Force
                && !string.IsNullOrWhiteSpace(game.CoverImagePath)
                && !string.IsNullOrWhiteSpace(game.ScreenshotImagePath))
            {
                skipped++;
                continue;
            }

            try
            {
                var anyUpdated = false;
                var anyFound = false;

                if (jobPayload.Force || string.IsNullOrWhiteSpace(game.CoverImagePath))
                {
                    var cover = await TryDownloadAsync(client, game, "Named_Boxarts", "cover.png", db, cancellationToken);
                    if (cover is not null)
                    {
                        game.CoverImagePath = cover;
                        anyUpdated = true;
                        anyFound = true;
                    }
                }

                if (jobPayload.Force || string.IsNullOrWhiteSpace(game.ScreenshotImagePath))
                {
                    var snap = await TryDownloadAsync(client, game, "Named_Snaps", "screenshot.png", db, cancellationToken);
                    if (snap is not null)
                    {
                        game.ScreenshotImagePath = snap;
                        anyUpdated = true;
                        anyFound = true;
                    }
                }

                game.GameArtProvider = ProviderName;
                game.LastGameArtLookupUtc = DateTime.UtcNow;
                game.GameArtError = null;
                game.GameArtStatus = anyFound || HasAnyArt(game) ? "found" : "not_found";

                if (anyUpdated)
                {
                    updated++;
                    await context.LogInfoAsync($"Game #{game.Id} '{game.Name}': art updated", cancellationToken);
                }
                else if (!HasAnyArt(game))
                {
                    notFound++;
                }
                else
                {
                    skipped++;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                game.GameArtProvider = ProviderName;
                game.GameArtStatus = "error";
                game.GameArtError = ex.Message.Length > 512 ? ex.Message[..512] : ex.Message;
                game.LastGameArtLookupUtc = DateTime.UtcNow;
                await context.LogWarnAsync($"Game #{game.Id} '{game.Name}' failed: {ex.Message}", cancellationToken);
            }

            // Report progress
            var permille = (int)(scanned / (double)candidates.Count * 1000);
            await context.SetProgressPermilleAsync(Math.Min(permille, 999), cancellationToken);

            await Task.Delay(100, cancellationToken);
        }

        await db.SaveChangesAsync(cancellationToken);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
        await context.LogInfoAsync($"Art backfill complete. Scanned {scanned}, updated {updated}, not_found {notFound}, skipped {skipped}, failed {failed}.", cancellationToken);
    }

    private async Task<string?> TryDownloadAsync(HttpClient client, Game game, string libretroFolder, string fileName, AppDbContext db, CancellationToken cancellationToken)
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
        var absoluteDirectory = Path.Combine(webRootPath, "art", "games", game.Id.ToString());
        Directory.CreateDirectory(absoluteDirectory);

        var absolutePath = Path.Combine(absoluteDirectory, fileName);
        await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
        await using (var output = File.Create(absolutePath))
        {
            await input.CopyToAsync(output, cancellationToken);
        }

        return $"/art/games/{game.Id}/{fileName}";
    }

    private static string BuildLibretroThumbnailUrl(string systemName, string folder, string gameName)
    {
        static string FileSegment(string value) => Uri.EscapeDataString(value);
        var repositoryName = systemName.Trim().Replace(" ", "_", StringComparison.Ordinal);
        return $"{RawBaseUrl}/{repositoryName}/master/{FileSegment(folder)}/{FileSegment(gameName)}.png";
    }

    private static bool HasAnyArt(Game game) =>
        !string.IsNullOrWhiteSpace(game.CoverImagePath) || !string.IsNullOrWhiteSpace(game.ScreenshotImagePath);
}
