namespace games_vault.Models.ViewModels;

public sealed class GameDetailsViewModel
{
    public required games_vault.Models.Game Game { get; init; }
    public required IReadOnlyList<games_vault.Models.GameFile> Files { get; init; }

    public int FilePage { get; init; }
    public int FilePageSize { get; init; }
    public int FileTotalCount { get; init; }

    public int FilePageCount => FilePageSize <= 0 ? 0 : (int)Math.Ceiling(FileTotalCount / (double)FilePageSize);
    public bool FileHasPrevious => FilePage > 1;
    public bool FileHasNext => FilePage < FilePageCount;
}
