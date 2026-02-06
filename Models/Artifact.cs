using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class Artifact
{
    public int Id { get; set; }

    [Required]
    [StringLength(260)]
    public string FileName { get; set; } = "";

    [Required]
    [StringLength(1000)]
    public string StoragePath { get; set; } = "";

    [StringLength(200)]
    public string? ContentType { get; set; }

    public long SizeBytes { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    [StringLength(200)]
    public string? Source { get; set; }
}

