using System.ComponentModel.DataAnnotations;

namespace games_vault.Models.ViewModels;

public sealed class ProfileEditViewModel
{
    [Required]
    [StringLength(80)]
    public string DisplayName { get; set; } = "";

    [StringLength(20)]
    public string Color { get; set; } = "#0d6efd";

    [StringLength(64)]
    public string? InviteCode { get; set; }
}
