using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.BackgroundJobs.Commands;

public sealed record ImportRomsFromLibretroDatabasePayload(
    string[] Paths,
    bool CreateUnknownGames = false,
    string UnknownSystemName = "Unknown");

[BackgroundJobCommand("rom.import")]
public sealed class ImportRomsFromLibretroDatabaseCommand(LibretroDatIndexBuilder indexBuilder) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, System.Text.Json.JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<ImportRomsFromLibretroDatabasePayload>(JobJson.Options);
        if (typed is null || typed.Paths.Length == 0)
        {
            throw new InvalidOperationException("rom.import payload must include at least one path.");
        }

        var index = indexBuilder.BuildFromDisk();
        if (index.ByCrc32.Count == 0)
        {
            throw new InvalidOperationException(
                "Libretro DAT index is empty. Run the 'libretro.sync' job first to download libretro-database.");
        }

        var paths = typed.Paths
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var processed = 0;
        var createdGames = 0;
        var createdFiles = 0;
        var pendingGames = new List<Game>();
        var pendingFiles = new List<GameFile>();
        const int batchSize = 100;

        // Pre-load existing games and files for the paths being imported to
        // avoid N+1 duplicate checks.
        var knownSystems = paths
            .Select(p => Path.GetExtension(p)?.TrimStart('.'))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(x => x!)
            .ToList();

        // Group multi-file games by (SystemName, GameName) when we have DAT matches.
        var gameCache = new Dictionary<string, Game>(StringComparer.OrdinalIgnoreCase);

        async Task FlushBatchAsync()
        {
            if (pendingGames.Count == 0 && pendingFiles.Count == 0)
                return;

            foreach (var g in pendingGames)
                context.Db.Games.Add(g);
            foreach (var f in pendingFiles)
                context.Db.GameFiles.Add(f);

            await context.Db.SaveChangesAsync(cancellationToken);
            pendingGames.Clear();
            pendingFiles.Clear();
        }

        foreach (var path in paths)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!System.IO.File.Exists(path))
            {
                context.Logger.LogWarning("ROM path does not exist: {Path}", path);
                processed++;
                continue;
            }

            var fileInfo = new FileInfo(path);
            await using var fs = fileInfo.OpenRead();

            var crc = await Crc32.ComputeAsync(fs, cancellationToken);
            var crcHex = crc.ToString("X8");

            var sizeBytes = fileInfo.Length;
            var fileName = fileInfo.Name;

            LibretroDatRomEntry? match = null;
            if (index.TryGetByCrc32(crcHex, out var found))
            {
                match = found;
            }

            if (match is null && !typed.CreateUnknownGames)
            {
                context.Logger.LogInformation("No libretro match for {File} (CRC32 {Crc32}); skipping", fileName, crcHex);
                processed++;
                continue;
            }

            var systemName = match?.SystemName ?? typed.UnknownSystemName;
            var gameName = match?.GameName ?? Path.GetFileNameWithoutExtension(fileName);

            var cacheKey = $"{systemName}\u001F{gameName}";
            if (!gameCache.TryGetValue(cacheKey, out var game))
            {
                game = await context.Db.Games.FirstOrDefaultAsync(
                    g => g.SystemName == systemName && g.Name == gameName,
                    cancellationToken);

                if (game is null)
                {
                    game = new Game
                    {
                        SystemName = systemName,
                        Name = gameName,
                        Crc32 = match is null ? null : crcHex,
                        SizeBytes = match is null ? sizeBytes : sizeBytes,
                        CreatedUtc = DateTime.UtcNow
                    };
                    pendingGames.Add(game);
                    createdGames++;

                    // Flush now so game.Id is available for file records below.
                    await FlushBatchAsync();
                }

                gameCache[cacheKey] = game;
            }

            // Avoid duplicate file records per game.
            var fileExists = pendingFiles.Any(f =>
                f.GameId == game.Id && f.Name == fileName && f.Crc32 == crcHex)
                || await context.Db.GameFiles.AnyAsync(
                    f => f.GameId == game.Id && f.Name == fileName && f.Crc32 == crcHex,
                    cancellationToken);

            if (!fileExists)
            {
                pendingFiles.Add(new GameFile
                {
                    GameId = game.Id,
                    Name = fileName,
                    Crc32 = crcHex,
                    SizeBytes = sizeBytes
                });
                createdFiles++;
            }

            processed++;

            if (processed % batchSize == 0)
            {
                await FlushBatchAsync();
                var progress = (int)(1000.0 * processed / Math.Max(1, paths.Length));
                await context.SetProgressPermilleAsync(progress, cancellationToken);
                await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
            }
        }

        // Final flush for any remaining items.
        await FlushBatchAsync();

        context.Logger.LogInformation("rom.import done: processed={Processed} createdGames={CreatedGames} createdFiles={CreatedFiles}", processed, createdGames, createdFiles);
        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}
