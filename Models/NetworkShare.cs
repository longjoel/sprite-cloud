using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public class NetworkShare
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    public string Name { get; set; } = "";

    [Required]
    [StringLength(500)]
    [Display(Name = "Path")]
    public string RootPath { get; set; } = "";

    [StringLength(200)]
    public string? Username { get; set; }

    // Stored in DB as plain text for now; consider moving to a secrets store later.
    [StringLength(500)]
    [Display(Name = "Password")]
    public string? Password { get; set; }

    public bool Enabled { get; set; } = true;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
