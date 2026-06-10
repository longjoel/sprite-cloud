using games_vault.Models;
using games_vault.Nosebleed;

namespace games_vault.Models.ViewModels;

public sealed class HomeIndexViewModel
{
    public bool ShowDashboard { get; set; }
    public int? CurrentProfileId { get; set; }
    public string? CurrentProfileName { get; set; }
    public string AccessMode { get; set; } = "Viewer";
    public bool CanPlay { get; set; }
    public bool CanManageLibrary { get; set; }
    public TimeSpan GlobalTotalPlayTime { get; set; }
    public int GlobalPlaySessionCount { get; set; }

    public int GamesCount { get; set; }
    public int SystemsCount { get; set; }

    public TimeSpan TotalPlayTime { get; set; }
    public int PlaySessionCount { get; set; }
    public string? LastPlayedGame { get; set; }
    public ActiveNosebleedSessionViewModel? FeaturedSession { get; set; }
    public IReadOnlyList<HomeLibraryPreviewGameViewModel> LibraryPreviewGames { get; set; } = [];
    public IReadOnlyList<TopPlayedGameViewModel> TopPlayedGames { get; set; } = [];
    public IReadOnlyList<ActiveNosebleedSessionViewModel> ActiveNosebleedSessions { get; set; } = [];
    public IReadOnlyList<ActiveNosebleedSessionViewModel> ActiveArcadeCabinets { get; set; } = [];
    public IReadOnlyList<ActiveNosebleedSessionViewModel> ActiveLibrarySessions { get; set; } = [];
    public IReadOnlyList<ActiveProfileSummaryViewModel> ActiveProfiles { get; set; } = [];
    public IReadOnlyList<HomeRecentSessionViewModel> RecentSessions { get; set; } = [];
    public IReadOnlyList<NosebleedProcessSnapshot> OrphanNosebleedProcesses { get; set; } = [];
    public IReadOnlyList<NosebleedRuntimeProcessViewModel> NosebleedRuntimeProcesses { get; set; } = [];
}

public sealed class TopPlayedGameViewModel
{
    public int GameId { get; set; }
    public string GameName { get; set; } = "Unknown game";
    public int SessionCount { get; set; }
    public TimeSpan TotalPlayTime { get; set; }
}

public sealed class ActiveNosebleedSessionViewModel
{
    public string SessionId { get; set; } = "";
    public int GameId { get; set; }
    public int FileId { get; set; }
    public string GameName { get; set; } = "Unknown game";
    public int Port { get; set; }
    public string BaseUrl { get; set; } = "";
    public DateTimeOffset StartedUtc { get; set; }
    public TimeSpan Runtime { get; set; }
    public string CorePath { get; set; } = "";
    public string ContentPath { get; set; } = "";
    public int ProcessId { get; set; }
    public bool HasExited { get; set; }
    public bool IsArcadeCabinet { get; set; }
    public int? ArcadeCabinetId { get; set; }
    public string? ArcadeCabinetName { get; set; }
    public string? RoomCode { get; set; }
}

public sealed class NosebleedRuntimeProcessViewModel
{
    public int ProcessId { get; set; }
    public string SessionId { get; set; } = "";
    public int? GameId { get; set; }
    public string? GameName { get; set; }
    public int? FileId { get; set; }
    public int? Port { get; set; }
    public string? BaseUrl { get; set; }
    public DateTimeOffset? StartedUtc { get; set; }
    public TimeSpan? Runtime { get; set; }
    public bool IsManaged { get; set; }
    public bool HasExited { get; set; }
    public bool IsArcadeCabinet { get; set; }
    public string? ArcadeCabinetName { get; set; }
    public string? RoomCode { get; set; }
    public string? CreatedByProfileName { get; set; }
    public string? CreatedByProfileUsername { get; set; }
    public string? ActiveParticipantNames { get; set; }
    public string? TelemetryProfileName { get; set; }
    public string? CorePath { get; set; }
    public string? ContentPath { get; set; }
    public string? CommandLine { get; set; }
    public double? AverageCpuPercent { get; set; }
    public long? WorkingSetBytes { get; set; }

    public string UserLabel
    {
        get
        {
            var owner = FormatProfile(CreatedByProfileName, CreatedByProfileUsername);
            if (!string.IsNullOrWhiteSpace(owner))
            {
                return owner;
            }

            if (!string.IsNullOrWhiteSpace(ActiveParticipantNames))
            {
                return ActiveParticipantNames!;
            }

            if (!string.IsNullOrWhiteSpace(TelemetryProfileName))
            {
                return TelemetryProfileName!;
            }

            return "No linked profile";
        }
    }

    public string SessionKind => IsArcadeCabinet ? "Arcade" : IsManaged ? "Library" : "External";

    private static string? FormatProfile(string? displayName, string? username)
    {
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return string.IsNullOrWhiteSpace(username) ? null : $"@{username}";
        }

        return string.IsNullOrWhiteSpace(username) ? displayName : $"{displayName} (@{username})";
    }
}

public sealed class ActiveProfileSummaryViewModel
{
    public int ProfileId { get; set; }
    public string DisplayName { get; set; } = "";
    public string? Username { get; set; }
    public string Color { get; set; } = "#0d6efd";
    public bool IsAdmin { get; set; }
    public bool IsCurrent { get; set; }
    public DateTime LastSeenUtc { get; set; }
    public string? CurrentGameName { get; set; }
    public string? CurrentMode { get; set; }
    public DateTime? CurrentSessionStartedUtc { get; set; }
}

public sealed class HomeRecentSessionViewModel
{
    public int GameId { get; set; }
    public string GameName { get; set; } = "";
    public string Mode { get; set; } = "";
    public DateTime StartedUtc { get; set; }
    public DateTime? EndedUtc { get; set; }
    public TimeSpan Duration { get; set; }
    public string? EndReason { get; set; }
    public int? ProfileId { get; set; }
    public string? ProfileName { get; set; }
    public bool IsActive => EndedUtc is null;
}

public sealed class HomeLibraryPreviewGameViewModel
{
    public int GameId { get; set; }
    public string GameName { get; set; } = "";
    public string SystemName { get; set; } = "";
    public string? Genre { get; set; }
    public int? NumberOfPlayers { get; set; }
    public bool IsRunningNow { get; set; }
}

public sealed class BackgroundJobSummary
{
    public int Id { get; set; }
    public string Command { get; set; } = "";
    public BackgroundJobStatus Status { get; set; }
    public int? ProgressPermille { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime? UpdatedUtc { get; set; }
    public DateTime? CompletedUtc { get; set; }

    public bool IsActive => Status is BackgroundJobStatus.Queued or BackgroundJobStatus.Running;

    public static BackgroundJobSummary? From(BackgroundJob? job)
    {
        if (job is null)
        {
            return null;
        }

        return new BackgroundJobSummary
        {
            Id = job.Id,
            Command = job.Command,
            Status = job.Status,
            ProgressPermille = job.ProgressPermille,
            CreatedUtc = job.CreatedUtc,
            UpdatedUtc = job.UpdatedUtc,
            CompletedUtc = job.CompletedUtc
        };
    }
}
