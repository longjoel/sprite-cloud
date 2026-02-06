using Microsoft.AspNetCore.Hosting;

namespace games_vault.Libretro.Import;

public sealed class SystemFileStorage(IWebHostEnvironment env)
{
    private string RootPath => Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data", "library", "system"));

    public string GetAbsoluteSystemPath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            throw new ArgumentException("Relative path is required.", nameof(relativePath));
        }

        relativePath = relativePath.Replace('\\', '/').Trim();
        while (relativePath.StartsWith("/"))
        {
            relativePath = relativePath[1..];
        }

        if (relativePath.Contains("..", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid relative path.");
        }

        var abs = Path.GetFullPath(Path.Combine(RootPath, relativePath));
        var root = Path.GetFullPath(RootPath);
        if (!abs.StartsWith(root, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid relative path.");
        }

        return abs;
    }

    public string GetAbsolutePath(string storagePath)
    {
        if (string.IsNullOrWhiteSpace(storagePath))
        {
            throw new ArgumentException("Storage path is required.", nameof(storagePath));
        }

        var abs = Path.GetFullPath(Path.Combine(env.ContentRootPath, storagePath));
        var root = Path.GetFullPath(Path.Combine(env.ContentRootPath, "App_Data"));
        if (!abs.StartsWith(root, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid storage path.");
        }
        return abs;
    }

    public async Task<string> StoreToSystemPathAsync(
        Func<Stream> openStream,
        string relativePath,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(RootPath);

        var abs = GetAbsoluteSystemPath(relativePath);
        var dir = Path.GetDirectoryName(abs);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        await using var input = openStream();
        await using var output = File.Create(abs);
        await input.CopyToAsync(output, cancellationToken);

        return Path.Combine("App_Data", "library", "system", relativePath.Replace('\\', '/')).Replace('\\', '/');
    }

    public async Task<string> StoreAsync(
        Func<Stream> openStream,
        string systemName,
        string displayName,
        string? crc32,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(RootPath);

        var systemFolder = SanitizeFolderName(systemName);
        var systemRoot = Path.Combine(RootPath, systemFolder);
        Directory.CreateDirectory(systemRoot);

        var original = TryGetOriginalFileName(displayName) ?? "system-file.bin";
        var fileName = BuildSafeFileName(original);
        var abs = Path.Combine(systemRoot, fileName);

        if (File.Exists(abs) && !string.IsNullOrWhiteSpace(crc32))
        {
            fileName = AppendCrcSuffix(fileName, crc32);
            abs = Path.Combine(systemRoot, fileName);
        }

        await using var input = openStream();
        await using var output = File.Create(abs);
        await input.CopyToAsync(output, cancellationToken);

        return Path.Combine("App_Data", "library", "system", systemFolder, fileName).Replace('\\', '/');
    }

    private static string? TryGetOriginalFileName(string displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return null;
        }

        displayName = displayName.Replace('\\', '/');
        var baseName = Path.GetFileName(displayName);
        return string.IsNullOrWhiteSpace(baseName) ? null : baseName;
    }

    private static string BuildSafeFileName(string originalFileName)
    {
        var baseName = (originalFileName ?? "").Trim();
        if (string.IsNullOrWhiteSpace(baseName))
        {
            baseName = "system-file.bin";
        }

        foreach (var c in Path.GetInvalidFileNameChars())
        {
            baseName = baseName.Replace(c, '_');
        }
        baseName = baseName.Replace('/', '_').Replace('\\', '_');

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

        if (systemName.Length > 80)
        {
            systemName = systemName[..80];
        }

        return systemName;
    }
}
