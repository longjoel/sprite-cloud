namespace games_vault.Models.ViewModels;

public sealed class GamePlayRoomSummaryViewModel
{
    public int Id { get; init; }
    public string Code { get; init; } = string.Empty;
    public string? SessionId { get; init; }
    public DateTime LastActiveUtc { get; init; }
}
