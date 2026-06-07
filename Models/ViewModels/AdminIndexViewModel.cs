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
}

public sealed class AdminStreamSettingsViewModel
{
    public string PreferredVideoTransport { get; set; } = "webrtc-track";
    public string WebSocketVideoCompression { get; set; } = "balanced";
    public string WebRtcVideoEncoder { get; set; } = "libvpx";
    public string? WebRtcVideoEncoderArgs { get; set; }
    public string FfmpegBinary { get; set; } = "ffmpeg";
    public string MediaBackend { get; set; } = "legacy";
}
