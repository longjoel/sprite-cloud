namespace games_vault.Models.ViewModels;

public sealed class ServerGamePlayViewModel
{
    public required games_vault.Models.Game Game { get; init; }
    public games_vault.Models.GameFile? File { get; init; }
    public bool PlayerEnabled { get; init; }
    public string? BaseUrl { get; init; }
    public string? SessionId { get; init; }
    public int? AssignedPort { get; init; }
    public int? PlayerNumber { get; init; }
    public bool IsSpectator { get; init; }
    public DateTimeOffset? SeatExpiresUtc { get; init; }
    public string? LeaveSessionReturnUrl { get; init; }
    public string? Error { get; init; }
    public int? CurrentRoomId { get; init; }
    public bool IsArcadeRoom { get; init; }
    public bool ShowRoomControls { get; init; } = true;
    public bool CanChat { get; init; }
    public string? CurrentProfileDisplayName { get; init; }
    public bool CurrentProfileIsEphemeralGuest { get; init; }
    public string? CurrentProfileParentDisplayName { get; init; }
    public IReadOnlyList<ProfileBatterySaveLogEntry> BatterySaveDiagnostics { get; init; } = [];
    public bool CanCreateShareLinks { get; init; }
    public string? GeneratedShareLink { get; init; }
    public string? GeneratedShareGrantMode { get; init; }

    public string? ChatIdentityLabel
    {
        get
        {
            if (!CurrentProfileIsEphemeralGuest)
            {
                return null;
            }

            return string.IsNullOrWhiteSpace(CurrentProfileParentDisplayName)
                ? "Chatting as guest"
                : $"Chatting as guest of {CurrentProfileParentDisplayName.Trim()}";
        }
    }
}
