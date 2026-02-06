using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class SystemFile
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    [Display(Name = "System")]
    public string SystemName { get; set; } = "";

    [Required]
    [StringLength(30)]
    public string Kind { get; set; } = "bios";

    [Required]
    [StringLength(260)]
    [Display(Name = "File name")]
    public string FileName { get; set; } = "";

    // Expected relative path under system directory (e.g. "dc/boot.bin", "pcsx2/bios/ps2.bin").
    [StringLength(500)]
    public string? TargetPath { get; set; }

    [StringLength(260)]
    public string? OriginalFileName { get; set; }

    [StringLength(8, MinimumLength = 8)]
    [RegularExpression("^[0-9A-Fa-f]{8}$", ErrorMessage = "CRC32 must be 8 hex characters.")]
    public string? Crc32 { get; set; }

    [Display(Name = "Size (bytes)")]
    [Range(0, long.MaxValue)]
    public long SizeBytes { get; set; }

    // Relative path under App_Data (e.g. "App_Data/library/system/Sony - PlayStation/scph5501.bin")
    [Required]
    [StringLength(1000)]
    public string StoragePath { get; set; } = "";

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
