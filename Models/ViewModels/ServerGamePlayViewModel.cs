namespace games_vault.Models.ViewModels;

public sealed class ServerGamePlayViewModel
{
    public required games_vault.Models.Game Game { get; init; }
    public games_vault.Models.GameFile? File { get; init; }
    public bool PlayerEnabled { get; init; }
    public string? BaseUrl { get; init; }
    public string? Token { get; init; }
    public string? SessionId { get; init; }
    public string? CorePath { get; init; }
    public string? ContentPath { get; init; }
    public string? Error { get; init; }
}
