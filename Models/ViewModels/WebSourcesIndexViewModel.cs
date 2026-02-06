namespace games_vault.Models.ViewModels;

public sealed class WebSourcesIndexViewModel
{
    public required IReadOnlyList<games_vault.Models.WebSource> Sources { get; init; }

    public int Page { get; init; }
    public int PageSize { get; init; }
    public int TotalCount { get; init; }

    public int PageCount => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasPrevious => Page > 1;
    public bool HasNext => Page < PageCount;
}

