using System.Text;
using Microsoft.Extensions.Options;

namespace games_vault.Libretro.Import;

public sealed class UploadStagingStore(IWebHostEnvironment env, IOptions<LibraryStorageOptions> options)
{
    private readonly LibraryStorageOptions _options = options.Value ?? new LibraryStorageOptions();

    private string RootPath => ResolveRootPath(_options.UploadStagingRootPath);

    public string CreateStagingDirectory()
    {
        Directory.CreateDirectory(RootPath);
        var dir = Path.Combine(RootPath, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    public bool IsWithinRoot(string fullPath)
    {
        var root = RootPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalized = Path.GetFullPath(fullPath);
        return normalized.StartsWith(root, StringComparison.Ordinal);
    }

    public async Task<string[]> SaveAsync(IEnumerable<IFormFile> files, string stagingDirectory, CancellationToken cancellationToken)
    {
        if (!IsWithinRoot(stagingDirectory))
        {
            throw new InvalidOperationException("Invalid staging directory.");
        }

        Directory.CreateDirectory(stagingDirectory);

        var saved = new List<string>();
        foreach (var file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (file.Length <= 0)
            {
                continue;
            }

            var safeName = MakeSafeFileName(file.FileName);
            var destPath = Path.Combine(stagingDirectory, safeName);
            destPath = EnsureUnique(destPath);

            await using var input = file.OpenReadStream();
            await using var output = File.Create(destPath);
            await input.CopyToAsync(output, cancellationToken);

            saved.Add(destPath);
        }

        return saved.ToArray();
    }

    public void TryDeleteDirectory(string path)
    {
        try
        {
            if (IsWithinRoot(path) && Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    private string ResolveRootPath(string? configuredRootPath)
    {
        configuredRootPath = (configuredRootPath ?? "").Trim();
        if (string.IsNullOrWhiteSpace(configuredRootPath))
        {
            configuredRootPath = "App_Data/uploads";
        }

        return Path.IsPathRooted(configuredRootPath)
            ? Path.GetFullPath(configuredRootPath)
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configuredRootPath));
    }

    private static string EnsureUnique(string destPath)
    {
        if (!File.Exists(destPath))
        {
            return destPath;
        }

        var dir = Path.GetDirectoryName(destPath)!;
        var baseName = Path.GetFileNameWithoutExtension(destPath);
        var ext = Path.GetExtension(destPath);

        for (var i = 2; i < 10_000; i++)
        {
            var candidate = Path.Combine(dir, $"{baseName} ({i}){ext}");
            if (!File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new IOException("Unable to create a unique filename for upload staging.");
    }

    private static string MakeSafeFileName(string fileName)
    {
        var name = Path.GetFileName(fileName);
        if (string.IsNullOrWhiteSpace(name))
        {
            name = "upload";
        }

        var sb = new StringBuilder(name.Length);
        foreach (var ch in name)
        {
            sb.Append(ch switch
            {
                '/' or '\\' => '_',
                ':' or '*' or '?' or '"' or '<' or '>' or '|' => '_',
                _ => ch
            });
        }

        return sb.ToString().Trim();
    }
}
