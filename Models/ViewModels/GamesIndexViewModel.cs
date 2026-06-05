namespace games_vault.Models.ViewModels;

public sealed class GamesIndexViewModel
{
    public required IReadOnlyList<games_vault.Models.Game> Games { get; init; }
    public GamesLibraryBrowseQuery Browse { get; init; } = new();
    public string? Query { get; init; }

    public int Page { get; init; }
    public int PageSize { get; init; }
    public int TotalCount { get; init; }

    public int SystemCount { get; init; }
    public int ActiveNowCount { get; init; }
    public int PlayedThisWeekCount { get; init; }
    public IReadOnlyList<GamesLibrarySystemOption> SystemOptions { get; init; } = Array.Empty<GamesLibrarySystemOption>();
    public IReadOnlyList<GamesLibraryPlayerCountOption> PlayerOptions { get; init; } = Array.Empty<GamesLibraryPlayerCountOption>();
    public IReadOnlyList<GamesLibraryGroupSection> Sections { get; init; } = Array.Empty<GamesLibraryGroupSection>();
    public IReadOnlySet<int> ActiveGameIds { get; init; } = new HashSet<int>();

    public int PageCount => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasPrevious => Page > 1;
    public bool HasNext => Page < PageCount;

    public int? BatchId { get; init; }
    public string? BatchName { get; init; }
    public IReadOnlyList<games_vault.Models.GameBatch> SavedBatches { get; init; } = Array.Empty<games_vault.Models.GameBatch>();
    public IReadOnlyList<games_vault.Models.Game> BatchGames { get; init; } = Array.Empty<games_vault.Models.Game>();
    public IReadOnlyList<int> BatchGameIds { get; init; } = Array.Empty<int>();
    public int BatchPage { get; init; }
    public int BatchPageSize { get; init; }
    public int BatchTotalCount { get; init; }
    public int BatchPageCount => BatchPageSize <= 0 ? 0 : (int)Math.Ceiling(BatchTotalCount / (double)BatchPageSize);
    public bool BatchHasPrevious => BatchPage > 1;
    public bool BatchHasNext => BatchPage < BatchPageCount;

    public IReadOnlyList<games_vault.EverDrive.EverDriveGbFirmwareOption> EverDriveGbFirmwares { get; init; } =
        Array.Empty<games_vault.EverDrive.EverDriveGbFirmwareOption>();
    public games_vault.EverDrive.EverDriveGbFirmwareOption? EverDriveGbLatest { get; init; }

    public bool EverDriveGbEligible { get; init; }
    public string? EverDriveGbIneligibleReason { get; init; }

    public required games_vault.Models.ViewModels.GameUploadCreateViewModel AddGame { get; init; }
    public bool OpenAddGameModal { get; init; }

    public IReadOnlyDictionary<string, games_vault.Models.ViewModels.SystemMissingInfo> MissingSystemFilesBySystem { get; init; } =
        new Dictionary<string, games_vault.Models.ViewModels.SystemMissingInfo>(StringComparer.OrdinalIgnoreCase);
}
