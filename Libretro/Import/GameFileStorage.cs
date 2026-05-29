using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Options;

namespace games_vault.Libretro.Import;

public sealed class GameFileStorage(IWebHostEnvironment env, IOptions<LibraryStorageOptions> options)
{
    private readonly LibraryStorageOptions _options = options.Value ?? new LibraryStorageOptions();

    private string LibraryRootPath => ResolveRootPath(_options.RootPath);
    private string RomsRootPath => Path.GetFullPath(Path.Combine(LibraryRootPath, "roms"));

    public string GetAbsolutePath(string storagePath)
    {
        if (string.IsNullOrWhiteSpace(storagePath))
        {
            throw new ArgumentException("Storage path is required.", nameof(storagePath));
        }

        // Back-compat: older paths are stored relative to content root under App_Data.
        var normalized = storagePath.Replace('\\', '/').TrimStart('/');
        if (normalized.StartsWith("App_Data/", StringComparison.OrdinalIgnoreCase))
        {
            var absLegacy = Path.GetFullPath(Path.Combine(env.ContentRootPath, normalized.Replace('/', Path.DirectorySeparatorChar)));
            var legacyRoot = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data")) + Path.DirectorySeparatorChar;
            if (!absLegacy.StartsWith(legacyRoot, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Invalid storage path.");
            }
            return absLegacy;
        }

        // New paths are relative to the configured library root.
        var abs = Path.GetFullPath(Path.Combine(LibraryRootPath, normalized.Replace('/', Path.DirectorySeparatorChar)));
        var root = EnsureTrailingSeparator(Path.GetFullPath(LibraryRootPath));
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
        CancellationToken cancellationToken,
        string? preferredFileName = null,
        bool rejectOnNameCollision = false)
    {
        Directory.CreateDirectory(RomsRootPath);

        var systemFolder = SanitizeFolderName(systemName);
        var systemRoot = Path.Combine(RomsRootPath, systemFolder);
        Directory.CreateDirectory(systemRoot);

        var original = string.IsNullOrWhiteSpace(preferredFileName)
            ? TryGetOriginalFileName(displayName)
            : preferredFileName;
        var fileName = BuildSafeFileName(original, crc32);
        var abs = Path.Combine(systemRoot, fileName);

        if (File.Exists(abs))
        {
            if (await ExistingFileMatchesAsync(abs, crc32, sizeBytes, cancellationToken))
            {
                return Path.Combine("roms", systemFolder, fileName).Replace('\\', '/');
            }

            if (rejectOnNameCollision)
            {
                throw new IOException($"A different ROM is already stored at the canonical arcade filename '{fileName}' for system '{systemName}'.");
            }

            // If this already exists, prefer a deterministic unique name so different ROMs with the same filename don't collide.
            fileName = AppendCrcSuffix(fileName, crc32);
            abs = Path.Combine(systemRoot, fileName);
            if (File.Exists(abs))
            {
                return Path.Combine("roms", systemFolder, fileName).Replace('\\', '/');
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

        return Path.Combine("roms", systemFolder, fileName).Replace('\\', '/');
    }

    private string ResolveRootPath(string? configuredRootPath)
    {
        configuredRootPath = (configuredRootPath ?? "").Trim();
        if (string.IsNullOrWhiteSpace(configuredRootPath))
        {
            configuredRootPath = "App_Data/library";
        }

        var abs = Path.IsPathRooted(configuredRootPath)
            ? Path.GetFullPath(configuredRootPath)
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configuredRootPath));

        return abs;
    }

    private static string EnsureTrailingSeparator(string path)
    {
        path = Path.GetFullPath(path);
        return path.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    }

    private static async Task<bool> ExistingFileMatchesAsync(
        string existingPath,
        string expectedCrc32,
        long expectedSizeBytes,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(existingPath);
        if (!info.Exists)
        {
            return false;
        }

        if (expectedSizeBytes > 0 && info.Length != expectedSizeBytes)
        {
            return false;
        }

        await using var stream = File.OpenRead(existingPath);
        var existingCrc32 = (await games_vault.Libretro.Crc32.ComputeAsync(stream, cancellationToken)).ToString("X8");
        return string.Equals(existingCrc32, expectedCrc32, StringComparison.OrdinalIgnoreCase);
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
