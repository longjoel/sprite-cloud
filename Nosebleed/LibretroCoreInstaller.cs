using System.IO.Compression;
using games_vault.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed record LibretroCoreInstallResult(int Installed, int AlreadyInstalled, int UnknownSystem, IReadOnlyList<string> InstalledCores);

public sealed class LibretroCoreInstaller(
    AppDbContext db,
    IHttpClientFactory httpClientFactory,
    IOptions<NosebleedOptions> options,
    ILogger<LibretroCoreInstaller> logger)
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();

    public async Task<LibretroCoreInstallResult> InstallKnownCoresForDetectedSystemsAsync(CancellationToken cancellationToken = default)
    {
        var coreRoot = _options.CoreRoot;
        if (string.IsNullOrWhiteSpace(coreRoot))
        {
            throw new InvalidOperationException("Nosebleed:CoreRoot is not configured.");
        }

        Directory.CreateDirectory(coreRoot);

        var systems = await db.Games
            .AsNoTracking()
            .Select(x => x.SystemName)
            .Distinct()
            .ToListAsync(cancellationToken);

        var neededCores = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var unknownSystem = 0;
        foreach (var rawSystemName in systems)
        {
            var systemName = rawSystemName.Trim();
            if (string.IsNullOrWhiteSpace(systemName))
            {
                continue;
            }

            var entry = CoreCompatibilityCatalog.Find(systemName);
            if (entry is null)
            {
                unknownSystem++;
                continue;
            }

            neededCores.Add(entry.NativeCoreFileName);
        }

        var installed = 0;
        var alreadyInstalled = 0;
        var installedCores = new List<string>();
        foreach (var coreFileName in neededCores)
        {
            var destination = Path.GetFullPath(Path.Combine(coreRoot, coreFileName));
            if (!destination.StartsWith(Path.GetFullPath(coreRoot), StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Invalid core file name: {coreFileName}");
            }

            if (File.Exists(destination))
            {
                alreadyInstalled++;
                continue;
            }

            await InstallCoreAsync(coreFileName, destination, cancellationToken);
            installed++;
            installedCores.Add(coreFileName);
        }

        return new LibretroCoreInstallResult(installed, alreadyInstalled, unknownSystem, installedCores);
    }

    public async Task InstallCoreAsync(string coreFileName, string destinationPath, CancellationToken cancellationToken = default)
    {
        if (!coreFileName.EndsWith("_libretro.so", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Unsupported native core file name: {coreFileName}");
        }

        var uri = BuildCoreZipUri(_options.CoreBuildbotBaseUrl, coreFileName);
        var zipPath = Path.Combine(Path.GetTempPath(), $"games-vault-core-{Guid.NewGuid():N}.zip");
        var extractPath = Path.Combine(Path.GetTempPath(), $"games-vault-core-{Guid.NewGuid():N}");
        try
        {
            logger.LogInformation("Installing libretro core {CoreFileName} from {Uri}", coreFileName, uri);
            var client = httpClientFactory.CreateClient();
            using (var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
            {
                response.EnsureSuccessStatusCode();
                await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
                await using var file = File.Create(zipPath);
                await source.CopyToAsync(file, cancellationToken);
            }

            Directory.CreateDirectory(extractPath);
            ZipFile.ExtractToDirectory(zipPath, extractPath, overwriteFiles: true);
            var extracted = Directory.EnumerateFiles(extractPath, coreFileName, SearchOption.AllDirectories)
                .FirstOrDefault();
            if (extracted is null)
            {
                throw new InvalidOperationException($"Downloaded archive did not contain {coreFileName}.");
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
            File.Copy(extracted, destinationPath, overwrite: true);
            TryMakeExecutable(destinationPath);
        }
        finally
        {
            TryDeleteFile(zipPath);
            TryDeleteDirectory(extractPath);
        }
    }

    public static Uri BuildCoreZipUri(string baseUrl, string coreFileName)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new InvalidOperationException("Nosebleed:CoreBuildbotBaseUrl is not configured.");
        }

        var root = baseUrl.TrimEnd('/') + "/";
        return new Uri(new Uri(root), Uri.EscapeDataString(coreFileName) + ".zip");
    }

    private static void TryMakeExecutable(string path)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }

        try
        {
            File.SetUnixFileMode(path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }
        catch
        {
            // Best effort: most libretro cores only need to be readable/loadable.
        }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); } catch { }
    }
}
