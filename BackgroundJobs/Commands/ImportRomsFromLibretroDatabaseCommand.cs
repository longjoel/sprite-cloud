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

        // Group multi-file games by (SystemName, GameName) when we have DAT matches.
        var gameCache = new Dictionary<string, Game>(StringComparer.OrdinalIgnoreCase);

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
                    context.Db.Games.Add(game);
                    await context.Db.SaveChangesAsync(cancellationToken);
                    createdGames++;
                }

                gameCache[cacheKey] = game;
            }

            // Avoid duplicate file records per game.
            var exists = await context.Db.GameFiles.AnyAsync(
                f => f.GameId == game.Id && f.Name == fileName && f.Crc32 == crcHex,
                cancellationToken);

            if (!exists)
            {
                context.Db.GameFiles.Add(new GameFile
                {
                    GameId = game.Id,
                    Name = fileName,
                    Crc32 = crcHex,
                    SizeBytes = sizeBytes
                });
                await context.Db.SaveChangesAsync(cancellationToken);
                createdFiles++;
            }

            processed++;

            if (processed % 5 == 0)
            {
                var progress = (int)(1000.0 * processed / Math.Max(1, paths.Length));
                await context.SetProgressPermilleAsync(progress, cancellationToken);
                await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
            }
        }

        context.Logger.LogInformation("rom.import done: processed={Processed} createdGames={CreatedGames} createdFiles={CreatedFiles}", processed, createdGames, createdFiles);
        await context.SetProgressPermilleAsync(1000, cancellationToken);
    }
}
