namespace games_vault.Models.ViewModels;

public enum ArcadeGamePickerSort
{
    AlphabeticalAsc,
    RecentlyAdded,
    System,
    NumberOfPlayers
}

public sealed class ArcadeGamePickerQuery
{
    public string? Q { get; set; }
    public string? System { get; set; }
    public int? Players { get; set; }
    public ArcadeGamePickerSort Sort { get; set; } = ArcadeGamePickerSort.AlphabeticalAsc;
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;

    public bool HasActiveFilters =>
        !string.IsNullOrWhiteSpace(Q)
        || !string.IsNullOrWhiteSpace(System)
        || Players is > 0;

    public ArcadeGamePickerQuery Normalize()
    {
        return new ArcadeGamePickerQuery
        {
            Q = string.IsNullOrWhiteSpace(Q) ? null : Q.Trim(),
            System = string.IsNullOrWhiteSpace(System) ? null : System.Trim(),
            Players = Players is > 0 ? Players : null,
            Sort = Sort,
            Page = Math.Max(1, Page),
            PageSize = Math.Clamp(PageSize, 5, 50)
        };
    }
}

public sealed class ArcadeGamePickerViewModel
{
    public ArcadeGamePickerQuery Query { get; init; } = new();
    public IReadOnlyList<ArcadeGamePickerGameViewModel> Games { get; init; } = Array.Empty<ArcadeGamePickerGameViewModel>();
    public IReadOnlyList<ArcadeGamePickerSystemOption> SystemOptions { get; init; } = Array.Empty<ArcadeGamePickerSystemOption>();
    public IReadOnlyList<ArcadeGamePickerPlayerOption> PlayerOptions { get; init; } = Array.Empty<ArcadeGamePickerPlayerOption>();
    public int TotalCount { get; init; }
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
    public int PageCount => TotalCount == 0 ? 1 : (int)Math.Ceiling(TotalCount / (double)PageSize);
}

public sealed class ArcadeGamePickerGameViewModel
{
    public int Id { get; init; }
    public string Name { get; init; } = string.Empty;
    public string SystemName { get; init; } = string.Empty;
    public int? NumberOfPlayers { get; init; }
    public int FileCount { get; init; }
    public int AlreadyCabinetCount { get; init; }
}

public sealed record ArcadeGamePickerSystemOption(string Name, int Count);
public sealed record ArcadeGamePickerPlayerOption(int Players, int Count);
