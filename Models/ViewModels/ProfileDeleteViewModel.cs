namespace games_vault.Models.ViewModels;

public sealed class ProfileDeleteViewModel
{
    public int Id { get; init; }
    public string DisplayName { get; init; } = "";
    public string? Username { get; init; }
    public string Color { get; init; } = "#0d6efd";
    public bool IsCurrent { get; init; }
    public int GameSaveCount { get; init; }
    public int GameSessionCount { get; init; }
    public int AuthSessionCount { get; init; }
}
