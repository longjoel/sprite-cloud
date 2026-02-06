using Microsoft.AspNetCore.Hosting;

namespace games_vault.Libretro.Import;

public sealed class GameFileStorage(IWebHostEnvironment env)
{
    private string RootPath => Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data", "library", "roms"));

    public string GetAbsolutePath(string storagePath)
    {
        if (string.IsNullOrWhiteSpace(storagePath))
        {
            throw new ArgumentException("Storage path is required.", nameof(storagePath));
        }

        // storagePath is relative to content root.
        var abs = Path.GetFullPath(Path.Combine(env.ContentRootPath, storagePath));
        var root = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data"));
        if (!abs.StartsWith(root, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid storage path.");
        }
        return abs;
    }

    public async Task<string> StoreAsync(
        Func<Stream> openStream,
        string displayName,
        string systemName,
        string crc32,
        long sizeBytes,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(RootPath);

        var systemFolder = SanitizeFolderName(systemName);
        var systemRoot = Path.Combine(RootPath, systemFolder);
        Directory.CreateDirectory(systemRoot);

        var original = TryGetOriginalFileName(displayName);
        var fileName = BuildSafeFileName(original, crc32);
        var abs = Path.Combine(systemRoot, fileName);

        if (File.Exists(abs))
        {
            // If this already exists, prefer a deterministic unique name so different ROMs with the same filename don't collide.
            fileName = AppendCrcSuffix(fileName, crc32);
            abs = Path.Combine(systemRoot, fileName);
            if (File.Exists(abs))
            {
                return Path.Combine("App_Data", "library", "roms", systemFolder, fileName).Replace('\\', '/');
            }
        }

        await using var input = openStream();
        await using var output = File.Create(abs);
        await input.CopyToAsync(output, cancellationToken);

        var info = new FileInfo(abs);
        if (sizeBytes > 0 && info.Exists && info.Length != sizeBytes)
        {
            // Keep the stored file anyway; but caller should log mismatch if needed.
        }

        return Path.Combine("App_Data", "library", "roms", systemFolder, fileName).Replace('\\', '/');
    }

    private static string? TryGetExtension(string displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return null;
        }

        // displayName may be "outer.zip:rom.gb" or deeper; we only care about the last component.
        var last = displayName;
        var idx = last.LastIndexOf(':');
        if (idx >= 0 && idx + 1 < last.Length)
        {
            last = last[(idx + 1)..];
        }

        var ext = Path.GetExtension(last);
        if (string.IsNullOrWhiteSpace(ext))
        {
            return null;
        }

        // Limit to a sane length.
        if (ext.Length > 12)
        {
            ext = ext[..12];
        }

        return ext;
    }

    private static string? TryGetOriginalFileName(string displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return null;
        }

        // displayName may be "outer.zip:dir/rom.gb" or deeper; use the last segment.
        var last = displayName;
        var idx = last.LastIndexOf(':');
        if (idx >= 0 && idx + 1 < last.Length)
        {
            last = last[(idx + 1)..];
        }

        last = last.Replace('\\', '/');
        var baseName = Path.GetFileName(last);
        return string.IsNullOrWhiteSpace(baseName) ? null : baseName;
    }

    private static string BuildSafeFileName(string? originalFileName, string crc32)
    {
        var baseName = (originalFileName ?? "").Trim();
        if (string.IsNullOrWhiteSpace(baseName))
        {
            return $"{crc32}.rom";
        }

        // Sanitize filename (keep extension if present).
        foreach (var c in Path.GetInvalidFileNameChars())
        {
            baseName = baseName.Replace(c, '_');
        }
        baseName = baseName.Replace('/', '_').Replace('\\', '_');

        // Avoid very long names.
        if (baseName.Length > 180)
        {
            var ext = Path.GetExtension(baseName);
            var stem = Path.GetFileNameWithoutExtension(baseName);
            stem = stem[..Math.Min(stem.Length, 180)];
            baseName = string.IsNullOrWhiteSpace(ext) ? stem : (stem + ext);
        }

        return baseName;
    }

    private static string AppendCrcSuffix(string fileName, string crc32)
    {
        var ext = Path.GetExtension(fileName);
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var withSuffix = $"{stem}-{crc32}{ext}";
        if (withSuffix.Length > 200)
        {
            withSuffix = withSuffix[..200];
        }
        return withSuffix;
    }

    private static string SanitizeFolderName(string systemName)
    {
        systemName = (systemName ?? "").Trim();
        if (string.IsNullOrWhiteSpace(systemName))
        {
            return "Unknown";
        }

        foreach (var c in Path.GetInvalidFileNameChars())
        {
            systemName = systemName.Replace(c, '_');
        }
        systemName = systemName.Replace('/', '_').Replace('\\', '_');

        // Keep folder names manageable.
        if (systemName.Length > 80)
        {
            systemName = systemName[..80];
        }

        return systemName;
    }
}
