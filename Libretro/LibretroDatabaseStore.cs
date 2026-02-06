using Microsoft.Extensions.Options;

namespace games_vault.Libretro;

public sealed class LibretroDatabaseStore(IWebHostEnvironment env, IOptions<LibretroDatabaseOptions> options)
{
    private readonly LibretroDatabaseOptions _options = options.Value;

    public string RootPath => Path.GetFullPath(Path.Combine(env.ContentRootPath, _options.RootPath));

    public string GetDatDirectoryPath() => Path.Combine(RootPath, "dat");
    public string GetMetaDatDirectoryPath() => Path.Combine(RootPath, "metadat");

    public void EnsureRootExists()
    {
        Directory.CreateDirectory(RootPath);
    }

    public bool HasDatFiles()
    {
        var datDir = GetDatDirectoryPath();
        return Directory.Exists(datDir) &&
               Directory.EnumerateFiles(datDir, "*.dat", SearchOption.AllDirectories).Any();
    }
}
