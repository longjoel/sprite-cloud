using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public class Arcade
{
    public int Id { get; set; }

    [Required]
    [StringLength(120)]
    public string Name { get; set; } = "Free Play Arcade";

    [Required]
    [StringLength(120)]
    public string Slug { get; set; } = "free-play";

    [StringLength(1000)]
    public string? Description { get; set; }

    public bool IsEnabled { get; set; } = true;
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedUtc { get; set; }

    public ICollection<ArcadeCabinet> Cabinets { get; set; } = new List<ArcadeCabinet>();
}
