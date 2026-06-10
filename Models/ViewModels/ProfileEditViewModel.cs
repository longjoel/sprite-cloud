using System.ComponentModel.DataAnnotations;

namespace games_vault.Models.ViewModels;

public sealed class ProfileEditViewModel
{
    [Required]
    [StringLength(80)]
    public string DisplayName { get; set; } = "";

    [Required]
    [StringLength(32)]
    [RegularExpression("^[A-Za-z0-9._-]{3,32}$", ErrorMessage = "Username must be 3-32 characters using only letters, numbers, periods, underscores, or hyphens.")]
    public string Username { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    [MinLength(8, ErrorMessage = "Password must be at least 8 characters.")]
    public string Password { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    [Compare(nameof(Password), ErrorMessage = "Password confirmation does not match.")]
    public string ConfirmPassword { get; set; } = "";

    [StringLength(20)]
    public string Color { get; set; } = "#0d6efd";

    [StringLength(32)]
    public string? AvatarKey { get; set; }

    [StringLength(500)]
    public string? Bio { get; set; }

    [StringLength(64)]
    public string? InviteCode { get; set; }
}
