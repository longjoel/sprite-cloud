using games_vault.Models;

namespace games_vault.Models.ViewModels;

public sealed record SystemFilesMissingItem(string RelativePath, string Crc32);

public sealed record SystemFilesMissingGroup(string System, IReadOnlyList<SystemFilesMissingItem> Missing);

public sealed class SystemFilesMissingViewModel
{
    public required IReadOnlyList<SystemFilesMissingGroup> Groups { get; init; }

    public IReadOnlyList<LocalFolder> LocalFolders { get; init; } = Array.Empty<LocalFolder>();
    public IReadOnlyList<NetworkShare> NetworkShares { get; init; } = Array.Empty<NetworkShare>();
}
