using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class ProfileGameSaveRevision
{
    public int Id { get; set; }

    [Required]
    public int ProfileGameSaveId { get; set; }
    public ProfileGameSave ProfileGameSave { get; set; } = null!;

    public int? GamePlaySessionId { get; set; }
    public GamePlaySession? GamePlaySession { get; set; }

    public DateTime RevisionTimestampUtc { get; set; } = DateTime.UtcNow;

    [Required]
    [StringLength(1000)]
    public string StoragePath { get; set; } = "";

    public long SizeBytes { get; set; }

    [Required]
    [StringLength(64)]
    public string Sha256 { get; set; } = "";

    [Required]
    [StringLength(20)]
    public string Source { get; set; } = "runtime";

    [StringLength(260)]
    public string? OriginalUploadFileName { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
