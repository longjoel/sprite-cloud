using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public enum BackgroundJobStatus
{
    Queued = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3,
    Canceled = 4,
    Paused = 5
}

public class BackgroundJob
{
    public int Id { get; set; }

    [Required]
    [StringLength(200)]
    public string Command { get; set; } = "";

    [Required]
    public string PayloadJson { get; set; } = "{}";

    public BackgroundJobStatus Status { get; set; } = BackgroundJobStatus.Queued;

    public int Attempt { get; set; }

    public int MaxAttempts { get; set; } = 3;

    public int? ProgressPermille { get; set; }

    public string? LastError { get; set; }

    [StringLength(100)]
    public string? LockedBy { get; set; }

    public DateTime? LockedUntilUtc { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime? StartedUtc { get; set; }

    public DateTime? CompletedUtc { get; set; }

    public DateTime? UpdatedUtc { get; set; }
}
