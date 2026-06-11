namespace games_vault.Models;

public sealed class ProfilePinnedGame
{
    public int Id { get; set; }
    public int ProfileId { get; set; }
    public UserProfile Profile { get; set; } = null!;
    public int GameId { get; set; }
    public Game Game { get; set; } = null!;
    public bool IsArchived { get; set; }
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
