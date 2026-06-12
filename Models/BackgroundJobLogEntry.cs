using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public class BackgroundJobLogEntry
{
    public int Id { get; set; }

    public int BackgroundJobId { get; set; }
    public BackgroundJob BackgroundJob { get; set; } = null!;

    [Required]
    [StringLength(20)]
    public string Level { get; set; } = "Information";

    [Required]
    [StringLength(4000)]
    public string Message { get; set; } = "";

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
