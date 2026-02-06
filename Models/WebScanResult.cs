using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class WebScanResult
{
    public int Id { get; set; }

    public int WebScanRunId { get; set; }
    public WebScanRun WebScanRun { get; set; } = null!;

    [Required]
    [StringLength(1000)]
    public string Url { get; set; } = "";

    [Required]
    [StringLength(260)]
    public string FileName { get; set; } = "";

    public long? SizeBytes { get; set; }
    public DateTime? LastModifiedUtc { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

