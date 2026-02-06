namespace games_vault.Models.ViewModels;

public sealed class WebPlayerPageViewModel
{
    public string BasePath { get; init; } = "/webplayer";
    public string? Core { get; init; }
    public string? RomUrl { get; init; }
    public string? RomName { get; init; }
    public int? GameId { get; init; }

    public string? SavesListUrl { get; init; }
    public string? SavesPutUrl { get; init; }
    public string? CsrfTokenUrl { get; init; }
}

