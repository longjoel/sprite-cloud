namespace games_vault.Models.ViewModels;

public sealed record SystemMissingInfo(int MissingCount, IReadOnlyList<string> SampleFiles);

public sealed record GamesLibraryActiveRoomOption(string Code, string PlayerName);

public sealed class GamesBankViewModel
{
    public required IReadOnlyList<games_vault.Models.Game> Games { get; init; }
    public GamesLibraryBrowseQuery Browse { get; init; } = new();
    public string? Query { get; init; }

    public int Page { get; init; }
    public int PageSize { get; init; }
    public int TotalCount { get; init; }

    public IReadOnlyList<GamesLibrarySystemOption> SystemOptions { get; init; } = Array.Empty<GamesLibrarySystemOption>();
    public IReadOnlyList<GamesLibraryPlayerCountOption> PlayerOptions { get; init; } = Array.Empty<GamesLibraryPlayerCountOption>();
    public IReadOnlyList<GamesLibraryGroupSection> Sections { get; init; } = Array.Empty<GamesLibraryGroupSection>();
    public IReadOnlySet<int> ActiveGameIds { get; init; } = new HashSet<int>();
    public IReadOnlyDictionary<int, IReadOnlyList<GamesLibraryActiveRoomOption>> ActiveRoomsByGameId { get; init; } =
        new Dictionary<int, IReadOnlyList<GamesLibraryActiveRoomOption>>();
    public bool CanManageLibrary { get; init; }

    public int PageCount => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasPrevious => Page > 1;
    public bool HasNext => Page < PageCount;

    public int? BatchId { get; init; }
    public IReadOnlyList<int> BatchGameIds { get; init; } = Array.Empty<int>();

    public IReadOnlyDictionary<string, SystemMissingInfo> MissingSystemFilesBySystem { get; init; } =
        new Dictionary<string, SystemMissingInfo>(StringComparer.OrdinalIgnoreCase);
}
