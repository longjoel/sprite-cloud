namespace games_vault.Models.ViewModels;

public sealed class ProfilesIndexViewModel
{
    public IReadOnlyList<ProfileSummaryViewModel> Profiles { get; init; } = [];
    public int? CurrentProfileId { get; init; }
    public string AccessMode { get; init; } = "Viewer";
}

public sealed class ProfileSummaryViewModel
{
    public int Id { get; init; }
    public string DisplayName { get; init; } = "";
    public string? Username { get; init; }
    public string Color { get; init; } = "#0d6efd";
    public int SessionCount { get; init; }
    public TimeSpan TotalPlayTime { get; init; }
    public DateTime? LastPlayedUtc { get; init; }
    public bool IsCurrent { get; init; }
    public bool IsAdmin { get; init; }
}
