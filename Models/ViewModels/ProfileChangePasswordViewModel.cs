using System.ComponentModel.DataAnnotations;

namespace games_vault.Models.ViewModels;

public sealed class ProfileChangePasswordViewModel
{
    public int ProfileId { get; set; }

    [Required]
    [DataType(DataType.Password)]
    public string CurrentPassword { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    [MinLength(8, ErrorMessage = "Password must be at least 8 characters.")]
    public string NewPassword { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    [Compare(nameof(NewPassword), ErrorMessage = "New password confirmation does not match.")]
    public string ConfirmNewPassword { get; set; } = "";
}
