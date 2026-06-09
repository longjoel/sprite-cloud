using SMBLibrary;
using SMBLibrary.Client;
using games_vault.Models;
using Microsoft.AspNetCore.DataProtection;

namespace games_vault.NetworkShares;

public sealed class SmbLibraryFileService : ISmbFileService
{
    private readonly PasswordProtector _passwordProtector;

    public SmbLibraryFileService(IDataProtectionProvider dataProtection)
    {
        _passwordProtector = new PasswordProtector(dataProtection);
    }

    public async Task<IReadOnlyList<SmbFileEntry>> SearchAsync(NetworkShare share, string? query, int maxResults, Func<string, Task>? log, CancellationToken cancellationToken)
    {
        var smbRoot = share.RootPath;
        var loc = SmbUri.Parse(smbRoot);

        var q = string.IsNullOrWhiteSpace(query) ? null : query.Trim().ToLowerInvariant();
        maxResults = Math.Clamp(maxResults, 1, 50_000);

        var results = new List<SmbFileEntry>(capacity: Math.Min(maxResults, 2000));

        if (log is not null)
        {
            await log($"SMB search: root={share.RootPath} host={loc.Host} share={loc.Share} subPath='{loc.SubPath}' query='{query ?? ""}' maxResults={maxResults}");
        }

        var password = _passwordProtector.Unprotect(share.Password);
        await using var session = await SmbSession.ConnectAsync(loc.Host, share.Username, password, cancellationToken);
        var store = session.TreeConnect(loc.Share);

        // BFS traversal starting at subpath
        var startDir = NormalizeToSmbPath(loc.SubPath);
        if (log is not null)
        {
            await log($"SMB search: startDir={startDir}");
        }
        var queue = new Queue<string>();
        queue.Enqueue(startDir);

        var visited = 0;
        while (queue.Count > 0 && results.Count < maxResults)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var dir = queue.Dequeue();
            visited++;
            foreach (var entry in SmbDirectoryEnumerator.ListDirectory(store, dir, log, cancellationToken))
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (TryExtractDirectoryEntry(entry, out var name, out var attributes, out var endOfFile, out var lastWriteUtc) != true)
                {
                    continue;
                }

                if (name is "." or "..")
                {
                    continue;
                }

                var isDir = (attributes & SMBLibrary.FileAttributes.Directory) != 0;

                if (isDir)
                {
                    var childDir = CombineSmbPath(dir, name);
                    queue.Enqueue(childDir);
                    continue;
                }

                if (q is not null && !name.ToLowerInvariant().Contains(q))
                {
                    continue;
                }

                // `smbRoot` already includes `loc.SubPath`, so only append the portion relative to the configured root.
                var relative = GetRelativeUrlPart(dir, startDir, name);
                var smbUri = SmbUri.Combine(smbRoot, relative);

                results.Add(new SmbFileEntry(
                    SmbUri: smbUri,
                    FileName: name,
                    SizeBytes: endOfFile,
                    LastWriteUtc: lastWriteUtc));

                if (results.Count >= maxResults)
                {
                    break;
                }
            }

            if (log is not null && visited % 200 == 0)
            {
                await log($"SMB search: visitedDirs={visited} results={results.Count} queue={queue.Count}");
            }
        }

        if (log is not null)
        {
            await log($"SMB search done: visitedDirs={visited} results={results.Count}");
        }

        return results;
    }

    public async Task CopyFileToAsync(NetworkShare share, string smbFileUri, string destinationPath, IProgress<int>? progressPermille, Func<string, Task>? log, CancellationToken cancellationToken)
    {
        var loc = SmbUri.Parse(share.RootPath);
        var relative = SmbUri.GetRelativePath(share.RootPath, smbFileUri);

        if (log is not null)
        {
            await log($"SMB copy: src={smbFileUri} dest={destinationPath} relative='{relative}'");
        }

        var copyPassword = _passwordProtector.Unprotect(share.Password);
        await using var session = await SmbSession.ConnectAsync(loc.Host, share.Username, copyPassword, cancellationToken);
        var store = session.TreeConnect(loc.Share);

        var smbPath = NormalizeToSmbPath(CombineUrlPath(loc.SubPath, relative));

        object handle;
        FileStatus fileStatus;
        var nt = store.CreateFile(
            out handle,
            out fileStatus,
            smbPath,
            AccessMask.GENERIC_READ,
            SMBLibrary.FileAttributes.Normal,
            ShareAccess.Read,
            CreateDisposition.FILE_OPEN,
            CreateOptions.FILE_NON_DIRECTORY_FILE,
            null);

        if (nt == NTStatus.STATUS_INVALID_PARAMETER && smbPath.StartsWith("\\", StringComparison.Ordinal))
        {
            var retry = smbPath.TrimStart('\\');
            nt = store.CreateFile(
                out handle,
                out fileStatus,
                retry,
                AccessMask.GENERIC_READ,
                SMBLibrary.FileAttributes.Normal,
                ShareAccess.Read,
                CreateDisposition.FILE_OPEN,
                CreateOptions.FILE_NON_DIRECTORY_FILE,
                null);
            smbPath = retry;
        }

        if (nt != NTStatus.STATUS_SUCCESS)
        {
            throw new InvalidOperationException($"SMB open failed ({nt}) for {smbFileUri}");
        }

        try
        {
            // Try to get size
            long total = 0;
            if (store.GetFileInformation(out var info, handle, FileInformationClass.FileStandardInformation) == NTStatus.STATUS_SUCCESS &&
                info is FileStandardInformation std)
            {
                total = (long)std.EndOfFile;
            }

            const int chunk = 1024 * 256;
            long offset = 0;
            var buffer = new byte[chunk];

            await using var output = File.Create(destinationPath);

                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var readStatus = store.ReadFile(out var data, handle, offset, chunk);
                    // Some SMB servers signal EOF via status code rather than returning 0 bytes with STATUS_SUCCESS.
                    if (readStatus == NTStatus.STATUS_END_OF_FILE)
                    {
                        break;
                    }

                    if (readStatus != NTStatus.STATUS_SUCCESS)
                    {
                        throw new InvalidOperationException($"SMB read failed ({readStatus}) for {smbFileUri}");
                    }

                    if (data.Length == 0)
                {
                    break;
                }

                await output.WriteAsync(data, cancellationToken);
                offset += data.Length;

                if (progressPermille is not null && total > 0)
                {
                    var p = (int)Math.Clamp(offset * 1000 / total, 0, 1000);
                    progressPermille.Report(p);
                }
            }

            if (log is not null)
            {
                await log($"SMB copy done: bytes={offset} total={total}");
            }
        }
        finally
        {
            store.CloseFile(handle);
        }
    }

    private static string NormalizeToSmbPath(string urlPath)
    {
        urlPath = urlPath.Trim().Replace('\\', '/');
        urlPath = urlPath.TrimStart('/');
        if (string.IsNullOrEmpty(urlPath))
        {
            return "\\";
        }
        return "\\" + urlPath.Replace('/', '\\');
    }

    private static string CombineSmbPath(string parent, string child)
    {
        parent = parent.TrimEnd('\\');
        child = child.Trim('\\');
        if (string.IsNullOrEmpty(parent) || parent == "\\")
        {
            return "\\" + child;
        }
        return parent + "\\" + child;
    }

    private static string CombineUrlPath(string? a, string? b)
    {
        a = (a ?? "").Trim('/');
        b = (b ?? "").Trim('/');
        if (string.IsNullOrEmpty(a)) return b;
        if (string.IsNullOrEmpty(b)) return a;
        return $"{a}/{b}";
    }

    private static string GetRelativeUrlPart(string currentDir, string startDir, string fileName)
    {
        // currentDir and startDir are SMB paths like "\foo\bar" or "\"
        var rel = currentDir.StartsWith(startDir, StringComparison.OrdinalIgnoreCase)
            ? currentDir[startDir.Length..]
            : currentDir;

        rel = rel.Trim('\\');
        rel = rel.Replace('\\', '/');
        return string.IsNullOrEmpty(rel) ? fileName : $"{rel}/{fileName}";
    }

    private static bool TryExtractDirectoryEntry(
        QueryDirectoryFileInformation entry,
        out string fileName,
        out SMBLibrary.FileAttributes attributes,
        out long sizeBytes,
        out DateTime? lastWriteUtc)
    {
        fileName = "";
        attributes = 0;
        sizeBytes = 0;
        lastWriteUtc = null;

        switch (entry)
        {
            case FileDirectoryInformation f:
                fileName = f.FileName;
                attributes = f.FileAttributes;
                sizeBytes = (long)f.EndOfFile;
                lastWriteUtc = f.LastWriteTime == DateTime.MinValue ? null : DateTime.SpecifyKind(f.LastWriteTime, DateTimeKind.Utc);
                return true;
            case FileFullDirectoryInformation f:
                fileName = f.FileName;
                attributes = f.FileAttributes;
                sizeBytes = (long)f.EndOfFile;
                lastWriteUtc = f.LastWriteTime == DateTime.MinValue ? null : DateTime.SpecifyKind(f.LastWriteTime, DateTimeKind.Utc);
                return true;
            case FileBothDirectoryInformation f:
                fileName = f.FileName;
                attributes = f.FileAttributes;
                sizeBytes = (long)f.EndOfFile;
                lastWriteUtc = f.LastWriteTime == DateTime.MinValue ? null : DateTime.SpecifyKind(f.LastWriteTime, DateTimeKind.Utc);
                return true;
            case FileIdBothDirectoryInformation f:
                fileName = f.FileName;
                attributes = f.FileAttributes;
                sizeBytes = (long)f.EndOfFile;
                lastWriteUtc = f.LastWriteTime == DateTime.MinValue ? null : DateTime.SpecifyKind(f.LastWriteTime, DateTimeKind.Utc);
                return true;
            default:
                // Unknown entry type; ignore.
                return false;
        }
    }

    private sealed class SmbSession : IAsyncDisposable
    {
        private readonly SMB2Client _client;

        private SmbSession(SMB2Client client)
        {
            _client = client;
        }

        public static async Task<SmbSession> ConnectAsync(string host, string? username, string? password, CancellationToken cancellationToken)
        {
            // SMBLibrary is synchronous; wrap connect in Task.Run to allow cancellation responsiveness.
            return await Task.Run(() =>
            {
                var client = new SMB2Client();
                if (!client.Connect(host, SMBTransportType.DirectTCPTransport))
                {
                    throw new InvalidOperationException($"Unable to connect to SMB host {host} on 445.");
                }

                var user = username ?? "";
                var pass = password ?? "";

                var status = client.Login(string.Empty, user, pass);
                if (status != NTStatus.STATUS_SUCCESS)
                {
                    client.Disconnect();
                    throw new InvalidOperationException($"SMB login failed: {status}");
                }

                return new SmbSession(client);
            }, cancellationToken);
        }

        public SMB2FileStore TreeConnect(string shareName)
        {
            // The library expects a share name or UNC; pass share name.
            var store = _client.TreeConnect(shareName, out var status);
            if (status != NTStatus.STATUS_SUCCESS || store is null)
            {
                throw new InvalidOperationException($"SMB tree connect failed: {status}");
            }

            if (store is SMB2FileStore smb2)
            {
                return smb2;
            }

            throw new InvalidOperationException($"Unexpected SMB file store type: {store.GetType().FullName}");
        }

        public ValueTask DisposeAsync()
        {
            try { _client.Logoff(); } catch { }
            try { _client.Disconnect(); } catch { }
            return ValueTask.CompletedTask;
        }
    }
}

internal static class SmbDirectoryEnumerator
{
    public static IEnumerable<QueryDirectoryFileInformation> ListDirectory(SMB2FileStore store, string smbPath, Func<string, Task>? log, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var nt = TryOpenDirectory(store, smbPath, out var handle, out var openedPath);

        if (nt != NTStatus.STATUS_SUCCESS)
        {
            if (log is not null)
            {
                log($"SMB list: failed to open dir {smbPath} ({nt})").GetAwaiter().GetResult();
            }
            throw new InvalidOperationException($"SMB list: failed to open directory '{openedPath}' ({nt})");
        }

        try
        {
            var status = store.QueryDirectory(out var list, handle, "*", FileInformationClass.FileDirectoryInformation);
            // Some servers return STATUS_NO_MORE_FILES on the first QueryDirectory call while still returning entries.
            // Treat that as a successful (terminal) response as long as we got a list back.
            if (status != NTStatus.STATUS_SUCCESS && status != NTStatus.STATUS_NO_MORE_FILES)
            {
                if (log is not null)
                {
                    log($"SMB list: query failed {openedPath} ({status})").GetAwaiter().GetResult();
                }
                throw new InvalidOperationException($"SMB list: query failed for directory '{openedPath}' ({status})");
            }

            if (list is null)
            {
                if (log is not null && status == NTStatus.STATUS_NO_MORE_FILES)
                {
                    log($"SMB list: no entries {openedPath} ({status})").GetAwaiter().GetResult();
                }
                return Array.Empty<QueryDirectoryFileInformation>();
            }

            if (log is not null && status == NTStatus.STATUS_NO_MORE_FILES)
            {
                log($"SMB list: returned {list.Count} entrie(s) {openedPath} ({status})").GetAwaiter().GetResult();
            }

            return list;
        }
        finally
        {
            store.CloseFile(handle);
        }
    }

    private static NTStatus TryOpenDirectory(SMB2FileStore store, string smbPath, out object handle, out string openedPath)
    {
        var nt = store.CreateFile(
            out handle,
            out _,
            smbPath,
            AccessMask.GENERIC_READ,
            SMBLibrary.FileAttributes.Normal,
            ShareAccess.Read,
            CreateDisposition.FILE_OPEN,
            CreateOptions.FILE_DIRECTORY_FILE,
            null);

        openedPath = smbPath;

        if (nt == NTStatus.STATUS_INVALID_PARAMETER && smbPath.StartsWith("\\", StringComparison.Ordinal))
        {
            var retry = smbPath.TrimStart('\\');
            nt = store.CreateFile(
                out handle,
                out _,
                retry,
                AccessMask.GENERIC_READ,
                SMBLibrary.FileAttributes.Normal,
                ShareAccess.Read,
                CreateDisposition.FILE_OPEN,
                CreateOptions.FILE_DIRECTORY_FILE,
                null);
            openedPath = retry;
        }

        return nt;
    }
}
