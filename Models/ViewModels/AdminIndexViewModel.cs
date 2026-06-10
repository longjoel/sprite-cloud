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
    public AdminStreamSettingsViewModel StreamSettings { get; set; } = new();
    public IReadOnlyList<NosebleedRuntimeProcessViewModel> NosebleedRuntimeProcesses { get; set; } = [];
    public IReadOnlyList<AdminRecentGameRow> RecentGames { get; set; } = [];
    public IReadOnlyList<AdminRecentJobRow> RecentJobs { get; set; } = [];
    public bool LibretroDatabaseInstalled { get; set; }
    public int? MissingSystemFilesCount { get; set; }
    public BackgroundJobSummary? LatestLibretroSyncJob { get; set; }
}

public sealed class AdminStreamSettingsViewModel
{
    public string PreferredVideoTransport { get; set; } = "webrtc-track";
    public string MediaBackend { get; set; } = "GStreamer";
}

public sealed class AdminRecentGameRow
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string SystemName { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
}

public sealed class AdminRecentJobRow
{
    public int Id { get; set; }
    public string Command { get; set; } = "";
    public string Status { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public int? ProgressPermille { get; set; }
}
