using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class LocalFolder
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    public string Name { get; set; } = "";

    [Required]
    [StringLength(500)]
    [Display(Name = "Path")]
    public string RootPath { get; set; } = "";

    public bool Enabled { get; set; } = true;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

