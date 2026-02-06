using games_vault.Models;

namespace games_vault.Models.ViewModels;

public sealed class SystemFilesIndexViewModel
{
    public required IReadOnlyList<games_vault.Models.SystemFile> Files { get; init; }
    public string? Query { get; init; }

    public int Page { get; init; }
    public int PageSize { get; init; }
    public int TotalCount { get; init; }

    public int PageCount => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasPrevious => Page > 1;
    public bool HasNext => Page < PageCount;

    public IReadOnlyList<BackgroundJob> RecentJobs { get; init; } = Array.Empty<BackgroundJob>();
}
