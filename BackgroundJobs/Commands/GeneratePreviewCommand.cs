using System.Text.Json;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.EntityFrameworkCore;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Gif;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace games_vault.BackgroundJobs.Commands;

public sealed class GeneratePreviewCommand(
    IServiceScopeFactory scopeFactory,
    NosebleedSessionManager nosebleedSessions,
    GameFileStorage fileStorage,
    IHttpClientFactory httpClientFactory) : IBackgroundJobCommand
{
    private const int FrameCount = 10;
    private const int FrameIntervalMs = 1000;

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var jobPayload = JsonSerializer.Deserialize<GeneratePreviewJobPayload>(payload.GetRawText(), JobJson.Options);
        if (jobPayload is null)
        {
            await context.LogErrorAsync("Invalid payload: expected { GameId, Force }", cancellationToken);
            return;
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var game = await db.Games
            .Include(g => g.Files)
            .FirstOrDefaultAsync(g => g.Id == jobPayload.GameId, cancellationToken);

        if (game is null)
        {
            await context.LogErrorAsync($"Game #{jobPayload.GameId} not found.", cancellationToken);
            return;
        }

        // Check if preview already exists
        if (!string.IsNullOrWhiteSpace(game.PreviewImagePath) && !jobPayload.Force)
        {
            await context.LogInfoAsync($"Game #{game.Id} already has a preview at '{game.PreviewImagePath}'. Use force=true to regenerate.", cancellationToken);
            return;
        }

        // Find a playable file
        var (file, contentPath) = ResolveGameFile(game, fileStorage);
        if (file is null || string.IsNullOrWhiteSpace(contentPath))
        {
            await context.LogErrorAsync($"No playable ROM file found for game #{game.Id}.", cancellationToken);
            return;
        }

        await context.LogInfoAsync($"Starting preview generation for game #{game.Id} ('{game.Name}') using file #{file.Id}", cancellationToken);

        // Start a fresh nosebleed session (force new, allow over capacity for previews)
        var startResult = await nosebleedSessions.StartFreshAsync(
            game.Id, file.Id, game.SystemName, contentPath,
            cancellationToken, allowOverCapacity: true);

        if (!startResult.Success || startResult.Session is null)
        {
            await context.LogErrorAsync($"Failed to start Nosebleed session: {startResult.Error}", cancellationToken);
            return;
        }

        var session = startResult.Session;
        string? previewPath = null;

        try
        {
            await context.LogInfoAsync($"Nosebleed session {session.Id} started on port {session.Port}. Capturing frames...", cancellationToken);

            // Give the emulator a moment to boot and render the first frame
            await Task.Delay(2000, cancellationToken);

            var frames = new List<Image<Rgba32>>();
            var client = httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(5);

            for (var i = 0; i < FrameCount; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                try
                {
                    var response = await client.GetAsync($"{session.LocalUrl}/session/snapshot", cancellationToken);
                    if (!response.IsSuccessStatusCode)
                    {
                        await context.LogWarnAsync($"Frame {i + 1}/{FrameCount}: snapshot returned {response.StatusCode}", cancellationToken);
                        await Task.Delay(FrameIntervalMs, cancellationToken);
                        continue;
                    }

                    var imageBytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
                    if (imageBytes.Length == 0)
                    {
                        await Task.Delay(FrameIntervalMs, cancellationToken);
                        continue;
                    }

                    var image = Image.Load<Rgba32>(imageBytes);
                    // Resize to a reasonable preview size (max 320px wide)
                    if (image.Width > 320)
                    {
                        image.Mutate(x => x.Resize(320, 0));
                    }
                    frames.Add(image);

                    var progress = (int)((i + 1) / (double)FrameCount * 1000);
                    await context.SetProgressPermilleAsync(progress, cancellationToken);
                    await context.LogInfoAsync($"Captured frame {i + 1}/{FrameCount} ({image.Width}x{image.Height})", cancellationToken);
                }
                catch (Exception ex)
                {
                    await context.LogWarnAsync($"Frame {i + 1}/{FrameCount} capture failed: {ex.Message}", cancellationToken);
                }

                await Task.Delay(FrameIntervalMs, cancellationToken);
            }

            if (frames.Count == 0)
            {
                await context.LogErrorAsync("No frames were captured.", cancellationToken);
                return;
            }

            // Assemble animated GIF
            await context.LogInfoAsync($"Assembling {frames.Count} frames into animated GIF...", cancellationToken);

            previewPath = await SavePreviewGifAsync(game.Id, frames, cancellationToken);
            foreach (var frame in frames)
            {
                frame.Dispose();
            }

            if (string.IsNullOrWhiteSpace(previewPath))
            {
                await context.LogErrorAsync("Failed to save preview GIF.", cancellationToken);
                return;
            }

            // Update game record
            game.PreviewImagePath = previewPath;
            await db.SaveChangesAsync(cancellationToken);

            await context.LogInfoAsync($"Preview saved to '{previewPath}' for game #{game.Id}", cancellationToken);
            await context.SetProgressPermilleAsync(1000, cancellationToken);
        }
        finally
        {
            // Always stop the nosebleed session
            await context.LogInfoAsync($"Stopping Nosebleed session {session.Id}...", cancellationToken);
            nosebleedSessions.TryStop(session.Id, "preview-complete");
        }
    }

    private static (GameFile? File, string? ContentPath) ResolveGameFile(Game game, GameFileStorage fileStorage)
    {
        var file = game.Files
            .Where(f => f.StoragePath != null || f.ExternalPath != null)
            .OrderBy(f => f.Name)
            .FirstOrDefault();

        if (file is null)
        {
            return (null, null);
        }

        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            var abs = fileStorage.GetAbsolutePath(file.StoragePath);
            return File.Exists(abs) ? (file, abs) : (file, null);
        }

        if (string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            return (file, null);
        }

        var full = Path.GetFullPath(file.ExternalPath);
        return File.Exists(full) ? (file, full) : (file, null);
    }

    private static async Task<string?> SavePreviewGifAsync(int gameId, IReadOnlyList<Image<Rgba32>> frames, CancellationToken cancellationToken)
    {
        var artDir = Path.GetFullPath(Path.Combine("wwwroot", "art", "games", gameId.ToString()));
        Directory.CreateDirectory(artDir);

        var gifPath = Path.Combine(artDir, "preview.gif");

        if (frames.Count == 0) return null;

        using var gif = frames[0].Clone();

        // Set frame delay (100 = 1 second in GIF units, centiseconds)
        var gifMeta = gif.Frames.RootFrame.Metadata.GetGifMetadata();
        gifMeta.FrameDelay = FrameIntervalMs / 10; // centiseconds

        // Add remaining frames
        for (var i = 1; i < frames.Count; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var frame = gif.Frames.AddFrame(frames[i].Frames.RootFrame);
            var frameMeta = frame.Metadata.GetGifMetadata();
            frameMeta.FrameDelay = FrameIntervalMs / 10;
        }

        // Loop forever
        gif.Metadata.GetGifMetadata().RepeatCount = 0;

        await gif.SaveAsGifAsync(gifPath, new GifEncoder(), cancellationToken);

        return $"/art/games/{gameId}/preview.gif";
    }
}
