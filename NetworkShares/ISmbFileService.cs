using games_vault.Models;

namespace games_vault.NetworkShares;

public interface ISmbFileService
{
    Task<IReadOnlyList<SmbFileEntry>> SearchAsync(NetworkShare share, string? query, int maxResults, Func<string, Task>? log, CancellationToken cancellationToken);
    Task CopyFileToAsync(NetworkShare share, string smbFileUri, string destinationPath, IProgress<int>? progressPermille, Func<string, Task>? log, CancellationToken cancellationToken);
}
