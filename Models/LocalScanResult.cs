using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class LocalScanResult
{
    public int Id { get; set; }

    public int LocalScanRunId { get; set; }
    public LocalScanRun LocalScanRun { get; set; } = null!;

    [Required]
    [StringLength(1000)]
    public string FullPath { get; set; } = "";

    [Required]
    [StringLength(260)]
    public string FileName { get; set; } = "";

    public long SizeBytes { get; set; }
    public DateTime? LastWriteUtc { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

