namespace games_vault.Models.ViewModels;

public sealed class AdminIndexViewModel
{
    public int GamesCount { get; set; }
    public int GameFilesCount { get; set; }
    public int SystemFilesCount { get; set; }
    public AdminStreamSettingsViewModel StreamSettings { get; set; } = new();
    public IReadOnlyList<NosebleedRuntimeProcessViewModel> NosebleedRuntimeProcesses { get; set; } = [];
    public bool LibretroDatabaseInstalled { get; set; }
    public int? MissingSystemFilesCount { get; set; }
    public int GamesWithCoverArtCount { get; set; }
    public int GamesWithScreenshotArtCount { get; set; }
    public int GamesMissingArtCount { get; set; }
    public int GameArtErrorCount { get; set; }
}

public sealed class AdminStreamSettingsViewModel
{
    public string PreferredVideoTransport { get; set; } = "webrtc-track";
    public string MediaBackend { get; set; } = "GStreamer";
}
