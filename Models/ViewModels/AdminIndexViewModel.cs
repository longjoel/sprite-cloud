namespace games_vault.Models.ViewModels;

public sealed class AdminIndexViewModel
{
    public int GamesCount { get; set; }
    public int GameFilesCount { get; set; }
    public int SystemFilesCount { get; set; }
    public int NetworkSharesCount { get; set; }
    public int LocalFoldersCount { get; set; }
    public int WebSourcesCount { get; set; }
    public int JobsQueuedOrRunningCount { get; set; }
    public int DownloadsCount { get; set; }
    public int ProfilesCount { get; set; }
    public int ProfileInviteCodesCount { get; set; }
    public int CoreMappingsCount { get; set; }
    public IReadOnlyList<NosebleedRuntimeProcessViewModel> NosebleedRuntimeProcesses { get; set; } = [];
}
