namespace games_vault.Models.ViewModels;

public sealed class GamePlayViewModel
{
    public required games_vault.Models.Game Game { get; init; }
    public games_vault.Models.GameFile? File { get; init; }

    public bool PlayerEnabled { get; init; }
    public string PlayerBasePath { get; init; } = "/webplayer";
    public bool PlayerAssetsPresent { get; init; }

    public string? CoreKey { get; init; }
    public string? RomUrl { get; init; }
    public string? Error { get; init; }
}

