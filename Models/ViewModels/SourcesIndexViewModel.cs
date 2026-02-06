namespace games_vault.Models.ViewModels;

public sealed class SourcesIndexViewModel
{
    public required IReadOnlyList<games_vault.Models.NetworkShare> NetworkShares { get; init; }
    public int NetworkSharesPage { get; init; }
    public int NetworkSharesPageSize { get; init; }
    public int NetworkSharesTotalCount { get; init; }
    public int NetworkSharesPageCount => NetworkSharesPageSize <= 0 ? 0 : (int)Math.Ceiling(NetworkSharesTotalCount / (double)NetworkSharesPageSize);
    public bool NetworkSharesHasPrevious => NetworkSharesPage > 1;
    public bool NetworkSharesHasNext => NetworkSharesPage < NetworkSharesPageCount;

    public required IReadOnlyList<games_vault.Models.LocalFolder> LocalFolders { get; init; }
    public int LocalFoldersPage { get; init; }
    public int LocalFoldersPageSize { get; init; }
    public int LocalFoldersTotalCount { get; init; }
    public int LocalFoldersPageCount => LocalFoldersPageSize <= 0 ? 0 : (int)Math.Ceiling(LocalFoldersTotalCount / (double)LocalFoldersPageSize);
    public bool LocalFoldersHasPrevious => LocalFoldersPage > 1;
    public bool LocalFoldersHasNext => LocalFoldersPage < LocalFoldersPageCount;

    public required IReadOnlyList<games_vault.Models.WebSource> WebSources { get; init; }
    public int WebSourcesPage { get; init; }
    public int WebSourcesPageSize { get; init; }
    public int WebSourcesTotalCount { get; init; }
    public int WebSourcesPageCount => WebSourcesPageSize <= 0 ? 0 : (int)Math.Ceiling(WebSourcesTotalCount / (double)WebSourcesPageSize);
    public bool WebSourcesHasPrevious => WebSourcesPage > 1;
    public bool WebSourcesHasNext => WebSourcesPage < WebSourcesPageCount;
}

