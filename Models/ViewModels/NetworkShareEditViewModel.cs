using System.ComponentModel.DataAnnotations;

namespace games_vault.Models.ViewModels;

public sealed class NetworkShareEditViewModel
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

    [StringLength(500)]
    [DataType(DataType.Password)]
    [Display(Name = "Password")]
    public string? Password { get; set; }

    public bool Enabled { get; set; } = true;
}

