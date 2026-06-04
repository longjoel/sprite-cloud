using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Http;

namespace games_vault.Models.ViewModels;

public sealed class ProfileBatterySaveUploadViewModel
{
    [Required]
    public int GameId { get; set; }

    [Required]
    public int GameFileId { get; set; }

    [Required]
    public string GameName { get; set; } = "";

    [Required]
    public string GameFileName { get; set; } = "";

    [Required]
    public string SystemName { get; set; } = "";

    [Display(Name = "Save key")]
    public string Key { get; set; } = "default";

    [Display(Name = "Save filename")]
    public string? FileName { get; set; }

    [Required]
    [Display(Name = "Save file")]
    public IFormFile? Upload { get; set; }

    public string? ReturnUrl { get; set; }
}