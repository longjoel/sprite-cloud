using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public class GameFile
{
    public int Id { get; set; }

    [Required]
    public int GameId { get; set; }

    public Game Game { get; set; } = null!;

    [Required]
    [StringLength(260)]
    [Display(Name = "File name")]
    public string Name { get; set; } = "";

    // Original filename (without zip prefixes / paths), for exports and display.
    [StringLength(260)]
    public string? OriginalFileName { get; set; }

    [StringLength(8, MinimumLength = 8)]
    [RegularExpression("^[0-9A-Fa-f]{8}$", ErrorMessage = "CRC32 must be 8 hex characters.")]
    public string? Crc32 { get; set; }

    [Display(Name = "File size (bytes)")]
    [Range(0, long.MaxValue)]
    public long SizeBytes { get; set; }

    // Relative path under App_Data (e.g. "library/roms/ABCD1234.gb")
    [StringLength(1000)]
    public string? StoragePath { get; set; }

    // Absolute path to a linked file outside App_Data (e.g. "/mnt/roms/game.gb").
    [StringLength(2000)]
    public string? ExternalPath { get; set; }
}
