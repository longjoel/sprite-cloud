using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class SystemCoreMappingResolver(IOptions<NosebleedOptions> nosebleedOptions)
{
    private readonly NosebleedOptions _options = nosebleedOptions.Value ?? new NosebleedOptions();

    public string? ResolveNativeCore(string systemName)
    {
        if (string.IsNullOrWhiteSpace(systemName))
        {
            return null;
        }

        var normalized = systemName.Trim();

        // Check appsettings fallback first
        if (_options.SystemCores.TryGetValue(normalized, out var configured) &&
            !string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim();
        }

        // Look up from built-in compatibility catalog
        var entry = CoreCompatibilityCatalog.Find(normalized);
        if (entry is not null)
        {
            return entry.NativeCoreFileName;
        }

        return null;
    }

    public IReadOnlyList<string> GetInstalledNativeCores()
    {
        var root = _options.CoreRoot;
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            return [];
        }

        return Directory.EnumerateFiles(root, "*_libretro.so", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFileName)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .OrderBy(x => x)
            .ToList();
    }
}
