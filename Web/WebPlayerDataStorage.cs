using Microsoft.AspNetCore.Hosting;

namespace games_vault.Web;

public sealed class WebPlayerDataStorage(IWebHostEnvironment env)
{
    private string RootPath => Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data", "webplayer"));

    public string GetAbsolutePath(string storagePath)
    {
        if (string.IsNullOrWhiteSpace(storagePath))
        {
            throw new ArgumentException("Storage path is required.", nameof(storagePath));
        }

        var abs = Path.GetFullPath(Path.Combine(env.ContentRootPath, storagePath.Replace('/', Path.DirectorySeparatorChar)));
        var root = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data"));
        if (!abs.StartsWith(root, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid storage path.");
        }

        return abs;
    }

    public string BuildRelativePath(int gameId, string kind, string key, string fileName)
    {
        if (gameId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(gameId));
        }

        kind = SanitizeSegment(kind);
        var keyParts = SanitizeKeyPath(key);
        fileName = SanitizeFileName(fileName);

        var parts = new List<string> { "App_Data", "webplayer", "games", gameId.ToString(), kind };
        parts.AddRange(keyParts);
        parts.Add(fileName);

        return Path.Combine(parts.ToArray()).Replace('\\', '/');
    }

    public async Task<(string storagePath, long sizeBytes)> StoreAsync(
        int gameId,
        string kind,
        string key,
        string fileName,
        Func<Stream> openStream,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(RootPath);

        var rel = BuildRelativePath(gameId, kind, key, fileName);
        var abs = GetAbsolutePath(rel);
        Directory.CreateDirectory(Path.GetDirectoryName(abs)!);

        await using var input = openStream();
        await using var output = File.Create(abs);
        await input.CopyToAsync(output, cancellationToken);

        var info = new FileInfo(abs);
        return (rel, info.Exists ? info.Length : 0);
    }

    private static string SanitizeSegment(string value)
    {
        value = (value ?? "").Trim();
        if (value.Length == 0)
        {
            return "default";
        }

        var cleaned = new string(value
            .Select(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '_')
            .ToArray());

        return cleaned.Length == 0 ? "default" : cleaned;
    }

    private static IReadOnlyList<string> SanitizeKeyPath(string key)
    {
        key = (key ?? "").Trim();
        if (key.Length == 0 || string.Equals(key, "default", StringComparison.OrdinalIgnoreCase))
        {
            return ["default"];
        }

        key = key.Replace('\\', '/');
        var segments = key
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(SanitizeSegment)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList();

        if (segments.Count == 0)
        {
            return ["default"];
        }

        // Keep the on-disk folder tree bounded.
        if (segments.Count > 12)
        {
            segments = segments.Take(12).ToList();
        }

        return segments;
    }

    private static string SanitizeFileName(string value)
    {
        value = (value ?? "").Trim();
        if (value.Length == 0)
        {
            return "file.bin";
        }

        // Drop any path components.
        value = value.Replace('\\', '/');
        value = Path.GetFileName(value);

        var cleaned = new string(value
            .Select(ch => char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_' ? ch : '_')
            .ToArray());

        if (cleaned.Length == 0)
        {
            return "file.bin";
        }

        if (cleaned.Length > 120)
        {
            cleaned = cleaned[..120];
        }

        return cleaned;
    }
}
