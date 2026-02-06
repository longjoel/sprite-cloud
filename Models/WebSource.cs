using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class WebSource
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    public string Name { get; set; } = "";

    [Required]
    [StringLength(1000)]
    [Display(Name = "Index URL")]
    public string IndexUrl { get; set; } = "";

    [StringLength(500)]
    [Display(Name = "Allowed extensions")]
    public string? AllowedExtensions { get; set; }

    public bool Enabled { get; set; } = true;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

