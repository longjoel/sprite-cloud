using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class GamePlayerFile
{
    public int Id { get; set; }

    [Required]
    public int GameId { get; set; }

    public Game Game { get; set; } = null!;

    // e.g. "sram", "savestate", "config"
    [Required]
    [StringLength(50)]
    public string Kind { get; set; } = "";

    // e.g. "slot1", "auto", "default"
    [Required]
    [StringLength(100)]
    public string Key { get; set; } = "default";

    [Required]
    [StringLength(260)]
    public string FileName { get; set; } = "";

    [Required]
    [StringLength(1000)]
    public string StoragePath { get; set; } = "";

    public long SizeBytes { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;
}

