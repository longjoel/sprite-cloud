namespace games_vault.Models.ViewModels;

public enum GamesLibrarySort
{
    RecentlyAdded,
    AlphabeticalAsc,
    AlphabeticalDesc,
    RecentlyPlayed,
    MostPlayedAllTime,
    MostPlayedThisWeek,
    NumberOfPlayers,
    System
}

public enum GamesLibraryGroup
{
    None,
    System,
    Alphabetical,
    NumberOfPlayers,
    CurrentlyPlaying
}

public sealed class GamesLibraryBrowseQuery
{
    public string? Q { get; set; }
    public string? System { get; set; }
    public int? Players { get; set; }
    public bool PlayingNow { get; set; }
    public GamesLibrarySort Sort { get; set; } = GamesLibrarySort.RecentlyAdded;
    public GamesLibraryGroup Group { get; set; } = GamesLibraryGroup.None;
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 25;

    public GamesLibraryBrowseQuery Normalize()
    {
        return new GamesLibraryBrowseQuery
        {
            Q = string.IsNullOrWhiteSpace(Q) ? null : Q.Trim(),
            System = string.IsNullOrWhiteSpace(System) ? null : System.Trim(),
            Players = Players is > 0 ? Players : null,
            PlayingNow = PlayingNow,
            Sort = Enum.IsDefined(Sort) ? Sort : GamesLibrarySort.RecentlyAdded,
            Group = Enum.IsDefined(Group) ? Group : GamesLibraryGroup.None,
            Page = Math.Max(1, Page),
            PageSize = Math.Clamp(PageSize, 5, 100)
        };
    }

    public bool HasActiveFilters =>
        !string.IsNullOrWhiteSpace(Q) ||
        !string.IsNullOrWhiteSpace(System) ||
        Players is > 0 ||
        PlayingNow;
}

public sealed record GamesLibrarySystemOption(string Name, int Count);

public sealed record GamesLibraryPlayerCountOption(int Players, int Count);

public sealed record GamesLibraryGroupSection(string? Label, IReadOnlyList<games_vault.Models.Game> Games);
