using System.ComponentModel.DataAnnotations.Schema;
using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public class Game
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    [Display(Name = "System")]
    public string SystemName { get; set; } = "";

    [Required]
    [StringLength(200)]
    public string Name { get; set; } = "";

    [StringLength(8, MinimumLength = 8)]
    [RegularExpression("^[0-9A-Fa-f]{8}$", ErrorMessage = "CRC32 must be 8 hex characters.")]
    public string? Crc32 { get; set; }

    [Display(Name = "File size (bytes)")]
    [Range(0, long.MaxValue)]
    public long SizeBytes { get; set; }

    [Display(Name = "Release date")]
    [DataType(DataType.Date)]
    public DateTime? ReleaseDate { get; set; }

    [Display(Name = "Players")]
    [Range(1, 64)]
    public int? NumberOfPlayers { get; set; }

    [StringLength(100)]
    public string? Genre { get; set; }

    [Display(Name = "Critic rating")]
    [Range(0, 100)]
    public decimal? CriticRating { get; set; }

    [Display(Name = "User rating")]
    [Range(0, 100)]
    public decimal? UserRating { get; set; }

    [Display(Name = "Critic genre")]
    [StringLength(100)]
    public string? CriticGenre { get; set; }

    [StringLength(512)]
    public string? CoverImagePath { get; set; }

    [StringLength(512)]
    public string? ScreenshotImagePath { get; set; }

    [StringLength(512)]
    public string? PreviewImagePath { get; set; }

    [StringLength(80)]
    public string? GameArtProvider { get; set; }

    [StringLength(32)]
    public string? GameArtStatus { get; set; }

    [StringLength(512)]
    public string? GameArtError { get; set; }

    public DateTime? LastGameArtLookupUtc { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public ICollection<GameFile> Files { get; set; } = [];

    [NotMapped]
    public int FileCount => Files?.Count ?? 0;
}
