using System.ComponentModel.DataAnnotations;

namespace games_vault.Models.ViewModels;

public sealed class ProfileSettingsViewModel
{
    public int Id { get; set; }

    [Required]
    [StringLength(80)]
    public string DisplayName { get; set; } = "";

    [StringLength(20)]
    public string Color { get; set; } = "#0d6efd";

    [StringLength(32)]
    public string? AvatarKey { get; set; }

    [StringLength(500)]
    public string? Bio { get; set; }
}
