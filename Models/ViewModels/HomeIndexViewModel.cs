using games_vault.Models;
using games_vault.Nosebleed;

namespace games_vault.Models.ViewModels;

public sealed class HomeIndexViewModel
{
    public bool ShowDashboard { get; set; }

    public int GamesCount { get; set; }
    public int SystemsCount { get; set; }
    public int GameFilesCount { get; set; }
    public long TotalGameBytes { get; set; }

    public TimeSpan TotalPlayTime { get; set; }
    public int PlaySessionCount { get; set; }
    public string? LastPlayedGame { get; set; }
    public IReadOnlyList<TopPlayedGameViewModel> TopPlayedGames { get; set; } = [];
    public IReadOnlyList<ActiveNosebleedSessionViewModel> ActiveNosebleedSessions { get; set; } = [];
    public IReadOnlyList<NosebleedProcessSnapshot> OrphanNosebleedProcesses { get; set; } = [];

    public int NetworkSharesCount { get; set; }
    public int LocalFoldersCount { get; set; }
    public int WebSourcesCount { get; set; }

    public int SystemFilesCount { get; set; }
    public int? MissingSystemFilesCount { get; set; }

    public bool LibretroDatabaseInstalled { get; set; }

    public bool WebPlayerEnabled { get; set; }
    public bool WebPlayerInstalled { get; set; }
    public string WebPlayerBasePath { get; set; } = "/webplayer";

    public BackgroundJobSummary? LatestLibretroSyncJob { get; set; }
    public BackgroundJobSummary? LatestWebPlayerInstallJob { get; set; }
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
