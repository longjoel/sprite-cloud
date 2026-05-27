using System.IO.Compression;
using games_vault.Libretro;

namespace games_vault.Libretro.Import;

public sealed class UploadFileScanner
{
    private const long MaxZipEntryBytes = 1024L * 1024L * 1024L; // 1 GiB safety cap
    private const int MaxZipRecursionDepth = 2;
    private const long MaxNestedZipBytes = 256L * 1024L * 1024L; // 256 MiB

    public async Task<List<ScannedUploadFile>> ScanAsync(IEnumerable<IFormFile> files, CancellationToken cancellationToken)
    {
        var results = new List<ScannedUploadFile>();

        foreach (var file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (file.Length <= 0)
            {
                continue;
            }

            if (IsZip(file.FileName))
            {
                await using (var stream = file.OpenReadStream())
                {
                    var crc = await Crc32.ComputeAsync(stream, cancellationToken);
                    results.Add(new ScannedUploadFile(
                        DisplayName: file.FileName,
                        SizeBytes: file.Length,
                        Crc32: crc.ToString("X8")));
                }

                await using var zipStream = file.OpenReadStream();
                await ScanZipStreamAsync(zipStream, file.FileName, depth: 0, results, cancellationToken);
            }
            else
            {
                await using var stream = file.OpenReadStream();
                var crc = await Crc32.ComputeAsync(stream, cancellationToken);
                results.Add(new ScannedUploadFile(
                    DisplayName: file.FileName,
                    SizeBytes: file.Length,
                    Crc32: crc.ToString("X8")));
            }
        }

        return results;
    }

    public async Task<List<ScannedUploadFile>> ScanPathsAsync(IEnumerable<string> paths, CancellationToken cancellationToken)
    {
        var results = new List<ScannedUploadFile>();

        foreach (var path in paths)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!File.Exists(path))
            {
                continue;
            }

            var fileInfo = new FileInfo(path);
            if (fileInfo.Length <= 0)
            {
                continue;
            }

            if (IsZip(fileInfo.Name))
            {
                await using var stream = File.OpenRead(path);
                var crc = await Crc32.ComputeAsync(stream, cancellationToken);
                results.Add(new ScannedUploadFile(
                    DisplayName: fileInfo.Name,
                    SizeBytes: fileInfo.Length,
                    Crc32: crc.ToString("X8")));

                stream.Position = 0;
                await ScanZipStreamAsync(stream, fileInfo.Name, depth: 0, results, cancellationToken);
            }
            else
            {
                await using var stream = File.OpenRead(path);
                var crc = await Crc32.ComputeAsync(stream, cancellationToken);
                results.Add(new ScannedUploadFile(
                    DisplayName: fileInfo.Name,
                    SizeBytes: fileInfo.Length,
                    Crc32: crc.ToString("X8")));
            }
        }

        return results;
    }

    private async Task ScanZipStreamAsync(Stream zipStream, string prefix, int depth, List<ScannedUploadFile> results, CancellationToken cancellationToken)
    {
        if (depth > MaxZipRecursionDepth)
        {
            return;
        }

        using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read, leaveOpen: true);
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (string.IsNullOrEmpty(entry.Name))
            {
                continue;
            }

            if (entry.Length <= 0 || entry.Length > MaxZipEntryBytes)
            {
                continue;
            }

            var displayName = $"{prefix}:{entry.FullName}";

            if (IsZip(entry.Name) && depth < MaxZipRecursionDepth && entry.Length <= MaxNestedZipBytes)
            {
                await using var nestedMs = new MemoryStream(capacity: (int)Math.Min(entry.Length, int.MaxValue));
                await using (var entryStream = entry.Open())
                {
                    await entryStream.CopyToAsync(nestedMs, cancellationToken);
                }
                nestedMs.Position = 0;
                await ScanZipStreamAsync(nestedMs, displayName, depth + 1, results, cancellationToken);
                continue;
            }

            await using var entryData = entry.Open();
            var crc = await Crc32.ComputeAsync(entryData, cancellationToken);

            results.Add(new ScannedUploadFile(
                DisplayName: displayName,
                SizeBytes: entry.Length,
                Crc32: crc.ToString("X8")));
        }
    }

    private static bool IsZip(string fileName) =>
        fileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);
}
