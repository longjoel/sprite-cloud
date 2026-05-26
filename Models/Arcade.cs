namespace games_vault.Models;

public class Arcade
{
    public int Id { get; set; }
    public string Name { get; set; } = "Free Play Arcade";
    public string Slug { get; set; } = "free-play";
    public string? Description { get; set; }
    public bool IsEnabled { get; set; } = true;
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedUtc { get; set; }

    public ICollection<ArcadeCabinet> Cabinets { get; set; } = new List<ArcadeCabinet>();
}
