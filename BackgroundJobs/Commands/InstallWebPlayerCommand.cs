using System.IO.Compression;
using System.Text.Json;
using games_vault.Web;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Options;
using System.Diagnostics;

namespace games_vault.BackgroundJobs.Commands;

public sealed record WebPlayerInstallPayload(bool Force = false);

[BackgroundJobCommand("webplayer.install")]
public sealed class InstallWebPlayerCommand(
    IHttpClientFactory httpClientFactory,
    IWebHostEnvironment env,
    IOptions<WebPlayerOptions> options) : IBackgroundJobCommand
{
    private readonly WebPlayerOptions _options = options.Value ?? new WebPlayerOptions();

    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = payload.Deserialize<WebPlayerInstallPayload>(JobJson.Options) ?? new WebPlayerInstallPayload();

        if (!_options.Enabled)
        {
            context.Logger.LogInformation("WebPlayer is disabled; skipping install.");
            await context.SetProgressPermilleAsync(1000, cancellationToken);
            return;
        }

        if (string.IsNullOrWhiteSpace(_options.RetroArchZipUrl))
        {
            throw new InvalidOperationException("WebPlayer:RetroArchZipUrl is not configured.");
        }

        var installUri = WebImportSafety.ParseAndValidateHttpUri(_options.RetroArchZipUrl);
        await WebImportSafety.EnsureSafeRemoteAsync(installUri, cancellationToken);

        var webRoot = env.WebRootPath;
        if (string.IsNullOrWhiteSpace(webRoot))
        {
            throw new InvalidOperationException("Web root is not configured.");
        }

        var basePath = string.IsNullOrWhiteSpace(_options.BasePath) ? "/webplayer" : _options.BasePath.TrimEnd('/');
        basePath = basePath.TrimStart('/');

        var targetRoot = Path.GetFullPath(Path.Combine(webRoot, basePath));
        var webRootFull = Path.GetFullPath(webRoot);
        if (!targetRoot.StartsWith(webRootFull, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Invalid WebPlayer:BasePath.");
        }

        if (!typed.Force && File.Exists(Path.Combine(targetRoot, "index.html")))
        {
            context.Logger.LogInformation("Web player folder already present; skipping install (set Force=true to reinstall).");
            await context.SetProgressPermilleAsync(1000, cancellationToken);
            return;
        }

        await context.SetProgressPermilleAsync(0, cancellationToken);

        var ext = Path.GetExtension(installUri.AbsolutePath);
        if (string.IsNullOrWhiteSpace(ext))
        {
            ext = ".bin";
        }

        var archivePath = Path.Combine(Path.GetTempPath(), $"webplayer-{Guid.NewGuid():N}{ext}");
        var extractPath = Path.Combine(Path.GetTempPath(), $"webplayer-{Guid.NewGuid():N}");

        try
        {
            var client = httpClientFactory.CreateClient();
            using (var response = await client.GetAsync(installUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
            {
                response.EnsureSuccessStatusCode();
                await using var remoteStream = await response.Content.ReadAsStreamAsync(cancellationToken);
                await using var fileStream = File.Create(archivePath);
                await remoteStream.CopyToAsync(fileStream, cancellationToken);
            }

            await context.SetProgressPermilleAsync(250, cancellationToken);
            await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);

            Directory.CreateDirectory(extractPath);

            await ExtractArchiveAsync(context, archivePath, extractPath, cancellationToken);

            await context.SetProgressPermilleAsync(950, cancellationToken);

            if (Directory.Exists(targetRoot))
            {
                Directory.Delete(targetRoot, recursive: true);
            }

            var contentRoot = TryResolveContentRoot(extractPath) ?? extractPath;
            EnsureIndexHtml(contentRoot);

            Directory.CreateDirectory(Path.GetDirectoryName(targetRoot)!);
            MoveOrCopyDirectory(contentRoot, targetRoot);

            if (!string.Equals(contentRoot, extractPath, StringComparison.Ordinal) && Directory.Exists(extractPath))
            {
                Directory.Delete(extractPath, recursive: true);
            }

            try
            {
                RetroArchWebPlayerPatch.ApplyToFolder(targetRoot, context.Logger);
            }
            catch (Exception ex)
            {
                context.Logger.LogWarning(ex, "Failed to apply web player patch.");
            }

            var marker = new
            {
                installedUtc = DateTime.UtcNow,
                source = installUri.ToString(),
                patch = RetroArchWebPlayerPatch.Marker
            };

            var markerPath = Path.Combine(targetRoot, "games-vault.webplayer.json");
            await File.WriteAllTextAsync(markerPath, JsonSerializer.Serialize(marker, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }), cancellationToken);

            await context.SetProgressPermilleAsync(1000, cancellationToken);
        }
        finally
        {
            TryDeleteFile(archivePath);
            // extractPath may have been moved; delete only if it still exists.
            TryDeleteDirectory(extractPath);
        }
    }

    private static async Task ExtractArchiveAsync(BackgroundJobExecutionContext context, string archivePath, string extractPath, CancellationToken cancellationToken)
    {
        var ext = Path.GetExtension(archivePath).ToLowerInvariant();
        if (ext == ".zip")
        {
            using var archive = ZipFile.OpenRead(archivePath);
            var entries = archive.Entries
                .Where(e => !string.IsNullOrEmpty(e.FullName) && !e.FullName.EndsWith("/", StringComparison.Ordinal))
                .ToList();

            var processed = 0;
            foreach (var entry in entries)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var relative = entry.FullName.Replace('\\', '/').TrimStart('/');
                if (string.IsNullOrWhiteSpace(relative))
                {
                    processed++;
                    continue;
                }

                if (relative.Contains("..", StringComparison.Ordinal) || relative.Contains(':', StringComparison.Ordinal))
                {
                    processed++;
                    continue;
                }

                var destinationPath = Path.GetFullPath(Path.Combine(extractPath, relative.Replace('/', Path.DirectorySeparatorChar)));
                if (!destinationPath.StartsWith(Path.GetFullPath(extractPath), StringComparison.Ordinal))
                {
                    processed++;
                    continue;
                }

                Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                entry.ExtractToFile(destinationPath, overwrite: true);

                processed++;
                if (processed % 200 == 0)
                {
                    var progress = 250 + (int)(650.0 * processed / Math.Max(1, entries.Count));
                    await context.SetProgressPermilleAsync(Math.Clamp(progress, 0, 950), cancellationToken);
                    await context.TouchLeaseAsync(TimeSpan.FromMinutes(5), cancellationToken);
                }
            }

            return;
        }

        if (ext == ".7z")
        {
            await Extract7zAsync(context, archivePath, extractPath, cancellationToken);
            return;
        }

        throw new InvalidOperationException($"Unsupported web player archive type '{ext}'. Use a .zip or .7z.");
    }

    private static async Task Extract7zAsync(BackgroundJobExecutionContext context, string archivePath, string extractPath, CancellationToken cancellationToken)
    {
        // We rely on a system '7z' (p7zip) install. This avoids adding a NuGet dependency that requires restore-time network.
        var exe = Find7zExecutable();
        if (exe is null)
        {
            throw new InvalidOperationException("7z extractor not found. Install 'p7zip' / '7z' on the host or provide a .zip web player build.");
        }

        Directory.CreateDirectory(extractPath);

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };

        psi.ArgumentList.Add("x");
        psi.ArgumentList.Add("-y");
        psi.ArgumentList.Add($"-o{extractPath}");
        psi.ArgumentList.Add(archivePath);

        using var proc = Process.Start(psi);
        if (proc is null)
        {
            throw new InvalidOperationException("Failed to start 7z process.");
        }

        var stdOutTask = proc.StandardOutput.ReadToEndAsync(cancellationToken);
        var stdErrTask = proc.StandardError.ReadToEndAsync(cancellationToken);

        await proc.WaitForExitAsync(cancellationToken);
        var stdout = await stdOutTask;
        var stderr = await stdErrTask;

        if (!string.IsNullOrWhiteSpace(stdout))
        {
            context.Logger.LogInformation("{Output}", stdout.Trim());
        }
        if (!string.IsNullOrWhiteSpace(stderr))
        {
            context.Logger.LogWarning("{Error}", stderr.Trim());
        }

        if (proc.ExitCode != 0)
        {
            throw new InvalidOperationException($"7z extraction failed with exit code {proc.ExitCode}.");
        }
    }

    private static string? Find7zExecutable()
    {
        // Common names across distros.
        foreach (var name in new[] { "7z", "7zz", "7zr" })
        {
            var path = FindOnPath(name);
            if (path is not null)
            {
                return path;
            }
        }

        return null;
    }

    private static string? FindOnPath(string exe)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var part in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(part, exe);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // ignore invalid PATH segments
            }
        }

        return null;
    }

    private static string? TryResolveContentRoot(string extractPath)
    {
        try
        {
            var dirs = Directory.EnumerateDirectories(extractPath).ToList();
            var files = Directory.EnumerateFiles(extractPath).ToList();
            if (files.Count == 0 && dirs.Count == 1)
            {
                return dirs[0];
            }
        }
        catch
        {
            // ignore
        }

        return null;
    }

    private static void EnsureIndexHtml(string contentRoot)
    {
        var index = Path.Combine(contentRoot, "index.html");
        if (File.Exists(index))
        {
            return;
        }

        var retroarch = Path.Combine(contentRoot, "retroarch.html");
        if (File.Exists(retroarch))
        {
            File.Copy(retroarch, index, overwrite: true);
        }
    }

    private static void MoveOrCopyDirectory(string sourcePath, string destinationPath)
    {
        try
        {
            Directory.Move(sourcePath, destinationPath);
        }
        catch (IOException)
        {
            CopyDirectory(sourcePath, destinationPath);
        }
    }

    private static void CopyDirectory(string sourcePath, string destinationPath)
    {
        Directory.CreateDirectory(destinationPath);

        foreach (var dir in Directory.EnumerateDirectories(sourcePath, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourcePath, dir);
            Directory.CreateDirectory(Path.Combine(destinationPath, rel));
        }

        foreach (var file in Directory.EnumerateFiles(sourcePath, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourcePath, file);
            var destFile = Path.Combine(destinationPath, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(destFile)!);
            File.Copy(file, destFile, overwrite: true);
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
