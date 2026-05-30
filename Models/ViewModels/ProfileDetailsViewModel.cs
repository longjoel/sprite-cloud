namespace games_vault.Models.ViewModels;

public sealed class ProfileDetailsViewModel
{
    public int Id { get; init; }
    public string DisplayName { get; init; } = "";
    public string Color { get; init; } = "#0d6efd";
    public bool IsCurrent { get; init; }
    public int SessionCount { get; init; }
    public TimeSpan TotalPlayTime { get; init; }
    public string? LastPlayedGame { get; init; }
    public ProfileChangePinViewModel ChangePin { get; init; } = new();
    public IReadOnlyList<ProfileTopGameViewModel> TopGames { get; init; } = [];
    public IReadOnlyList<ProfileRecentSessionViewModel> RecentSessions { get; init; } = [];
}

public sealed class ProfileTopGameViewModel
{
    public int GameId { get; init; }
    public string GameName { get; init; } = "";
    public int SessionCount { get; init; }
    public TimeSpan TotalPlayTime { get; init; }
}

public sealed class ProfileRecentSessionViewModel
{
    public int GameId { get; init; }
    public string GameName { get; init; } = "";
    public string Mode { get; init; } = "";
    public DateTime StartedUtc { get; init; }
    public DateTime? EndedUtc { get; init; }
    public TimeSpan Duration { get; init; }
    public string? EndReason { get; init; }
}
