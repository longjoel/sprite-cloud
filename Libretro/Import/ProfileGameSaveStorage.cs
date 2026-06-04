using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Options;

namespace games_vault.Libretro.Import;

public sealed class ProfileGameSaveStorage(IWebHostEnvironment env, IOptions<LibraryStorageOptions> options)
{
    private readonly LibraryStorageOptions _options = options.Value ?? new LibraryStorageOptions();

    private string ProfileSaveRootPath => ResolveProfileSaveRootPath();

    public string GetAbsolutePath(string storagePath)
    {
        if (string.IsNullOrWhiteSpace(storagePath))
        {
            throw new ArgumentException("Storage path is required.", nameof(storagePath));
        }

        var normalized = storagePath.Replace('\\', '/').Trim().TrimStart('/');
        var abs = Path.GetFullPath(Path.Combine(ProfileSaveRootPath, normalized.Replace('/', Path.DirectorySeparatorChar)));
        var root = EnsureTrailingSeparator(Path.GetFullPath(ProfileSaveRootPath));
        if (!abs.StartsWith(root, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid storage path.");
        }

        return abs;
    }

    public async Task<string> StoreRevisionAsync(
        Func<Stream> openStream,
        int profileId,
        int gameId,
        int gameFileId,
        int profileGameSaveId,
        DateTime revisionTimestampUtc,
        string sha256Prefix,
        string extension,
        CancellationToken cancellationToken)
    {
        revisionTimestampUtc = revisionTimestampUtc.Kind == DateTimeKind.Utc
            ? revisionTimestampUtc
            : revisionTimestampUtc.ToUniversalTime();

        var safeExtension = NormalizeExtension(extension);
        var safeHashPrefix = NormalizeHashPrefix(sha256Prefix);
        var relativePath = Path.Combine(
                "profiles",
                profileId.ToString(),
                "games",
                gameId.ToString(),
                "files",
                gameFileId.ToString(),
                "battery",
                profileGameSaveId.ToString(),
                $"{revisionTimestampUtc:yyyyMMdd'T'HHmmss'Z'}-{safeHashPrefix}{safeExtension}")
            .Replace('\\', '/');

        var abs = GetAbsolutePath(relativePath);
        var dir = Path.GetDirectoryName(abs);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        await using var input = openStream();
        await using var output = File.Create(abs);
        await input.CopyToAsync(output, cancellationToken);
        return relativePath;
    }

    private string ResolveProfileSaveRootPath()
    {
        var configuredRootPath = (_options.ProfileSaveRootPath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(configuredRootPath))
        {
            configuredRootPath = Path.Combine(ResolveRootPath(_options.RootPath), "profile-saves");
        }

        return Path.IsPathRooted(configuredRootPath)
            ? Path.GetFullPath(configuredRootPath)
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configuredRootPath));
    }

    private string ResolveRootPath(string? configuredRootPath)
    {
        configuredRootPath = (configuredRootPath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(configuredRootPath))
        {
            configuredRootPath = "App_Data/library";
        }

        return Path.IsPathRooted(configuredRootPath)
            ? Path.GetFullPath(configuredRootPath)
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configuredRootPath));
    }

    private static string EnsureTrailingSeparator(string path)
    {
        path = Path.GetFullPath(path);
        return path.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    }

    private static string NormalizeExtension(string extension)
    {
        extension = (extension ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(extension))
        {
            throw new ArgumentException("Extension is required.", nameof(extension));
        }

        if (!extension.StartsWith(".", StringComparison.Ordinal))
        {
            extension = "." + extension;
        }

        if (extension.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || extension.Contains('/') || extension.Contains('\\'))
        {
            throw new InvalidOperationException("Invalid extension.");
        }

        return extension;
    }

    private static string NormalizeHashPrefix(string sha256Prefix)
    {
        sha256Prefix = (sha256Prefix ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha256Prefix))
        {
            throw new ArgumentException("Hash prefix is required.", nameof(sha256Prefix));
        }

        if (sha256Prefix.Any(c => !Uri.IsHexDigit(c)))
        {
            throw new InvalidOperationException("Invalid hash prefix.");
        }

        return sha256Prefix;
    }
}
