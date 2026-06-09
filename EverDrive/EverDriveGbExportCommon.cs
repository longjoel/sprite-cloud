using System.IO.Compression;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.EverDrive;

public sealed record EverDriveGbExportPayload(int BatchId, string FirmwareUrl, string FirmwareLabel);

public static class EverDriveGbExportCommon
{
    public const string SystemGb = "Nintendo - Game Boy";
    public const string SystemGbc = "Nintendo - Game Boy Color";

    public static bool IsGbOrGbcSystem(string? systemName) =>
        string.Equals(systemName, SystemGb, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(systemName, SystemGbc, StringComparison.OrdinalIgnoreCase);

    public static string GetSystemFolder(string systemName) =>
        string.Equals(systemName, SystemGbc, StringComparison.OrdinalIgnoreCase) ? "GBC" : "GB";

    public static async Task<(string BatchName, IReadOnlyList<GameFile> UsableFiles)> GetUsableFilesAsync(
        AppDbContext db,
        int batchId,
        CancellationToken cancellationToken)
    {
        var batch = await db.GameBatches
            .AsNoTracking()
            .Where(x => x.Id == batchId)
            .Select(x => new { x.Id, x.Name })
            .FirstOrDefaultAsync(cancellationToken);

        if (batch is null)
        {
            throw new InvalidOperationException("Batch not found.");
        }

        var batchGames = await db.GameBatchItems
            .AsNoTracking()
            .Where(x => x.GameBatchId == batch.Id)
            .Select(x => x.GameId)
            .ToListAsync(cancellationToken);

        if (batchGames.Count == 0)
        {
            throw new InvalidOperationException("Batch is empty.");
        }

        var files = await db.GameFiles
            .AsNoTracking()
            .Where(f => batchGames.Contains(f.GameId) && (f.StoragePath != null || f.ExternalPath != null))
            .Include(f => f.Game)
            .OrderBy(f => f.Game.SystemName)
            .ThenBy(f => f.Game.Name)
            .ToListAsync(cancellationToken);

        var usable = files
            .Where(f => IsGbOrGbcSystem(f.Game.SystemName))
            .ToList();

        if (usable.Count == 0)
        {
            throw new InvalidOperationException("No usable Game Boy / Game Boy Color files found in this batch yet. Import games first.");
        }

        return (batch.Name, usable);
    }

    public static async Task<string> DownloadFirmwareZipAsync(
        IWebHostEnvironment env,
        IHttpClientFactory httpClientFactory,
        Func<string, Task> log,
        string url,
        CancellationToken cancellationToken)
    {
        var cacheRoot = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data", "everdrive-gb", "firmware"));
        Directory.CreateDirectory(cacheRoot);

        var fileName = Path.GetFileName(new Uri(url).AbsolutePath);
        if (string.IsNullOrWhiteSpace(fileName) || !fileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            fileName = "firmware.zip";
        }

        var cached = Path.Combine(cacheRoot, fileName);
        if (File.Exists(cached))
        {
            return cached;
        }

        var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.UserAgent.ParseAdd("games-vault/1.0");

        await log($"Downloading firmware: {url}");
        using var res = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        res.EnsureSuccessStatusCode();

        await using var input = await res.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = File.Create(cached);
        await input.CopyToAsync(output, cancellationToken);

        return cached;
    }

    public static void ExtractFirmwareTo(string firmwareZipPath, string destinationDir)
    {
        ZipFile.ExtractToDirectory(firmwareZipPath, destinationDir, overwriteFiles: true);
    }

    public static int CopyRomsToSdTree(
        GameFileStorage storage,
        IReadOnlyList<GameFile> usableFiles,
        string contentDir,
        Func<string, Task> logWarn)
    {
        var copied = 0;

        foreach (var f in usableFiles)
        {
            var sysDir = GetSystemFolder(f.Game.SystemName);
            var destDir = Path.Combine(contentDir, sysDir);
            Directory.CreateDirectory(destDir);

            var srcAbs = GetSourceAbsolutePath(storage, f);
            if (!File.Exists(srcAbs))
            {
                Task.Run(() => logWarn($"Missing file for {f.Name} (crc={f.Crc32}) at {(f.StoragePath ?? f.ExternalPath ?? "(unknown)")}")).GetAwaiter().GetResult();
                continue;
            }

            var ext = Path.GetExtension(srcAbs);
            var baseName = SanitizeFileName(f.Game.Name);
            var destName = $"{baseName}{ext}";
            var destAbs = Path.Combine(destDir, destName);

            if (File.Exists(destAbs))
            {
                destName = $"{baseName}-{f.Crc32}{ext}";
                destAbs = Path.Combine(destDir, destName);
            }

            File.Copy(srcAbs, destAbs, overwrite: false);
            copied++;
        }

        return copied;
    }

    private static string GetSourceAbsolutePath(GameFileStorage storage, GameFile file)
    {
        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            return storage.GetAbsolutePath(file.StoragePath);
        }

        if (!string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            return Path.GetFullPath(file.ExternalPath);
        }

        throw new InvalidOperationException("Game file has no storage path.");
    }

    public static string SanitizeFileName(string name)
    {
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            return "game";
        }

        foreach (var c in Path.GetInvalidFileNameChars())
        {
            name = name.Replace(c, '_');
        }

        name = name.Replace('/', '_').Replace('\\', '_');
        if (name.Length > 120)
        {
            name = name[..120];
        }

        return name;
    }
}
