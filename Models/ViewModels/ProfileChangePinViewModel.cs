using System.ComponentModel.DataAnnotations;

namespace games_vault.Models.ViewModels;

public sealed class ProfileChangePinViewModel
{
    public int ProfileId { get; set; }

    [Required]
    [DataType(DataType.Password)]
    [RegularExpression("^\\d{4}$", ErrorMessage = "PINs must be exactly 4 digits.")]
    public string CurrentPin { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    [RegularExpression("^\\d{4}$", ErrorMessage = "PINs must be exactly 4 digits.")]
    public string NewPin { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    [Compare(nameof(NewPin), ErrorMessage = "New PIN confirmation does not match.")]
    public string ConfirmNewPin { get; set; } = "";
}
