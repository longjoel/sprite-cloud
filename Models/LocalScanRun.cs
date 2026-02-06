namespace games_vault.Models;

public enum LocalScanStatus
{
    Queued = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3
}

public sealed class LocalScanRun
{
    public int Id { get; set; }

    public int LocalFolderId { get; set; }
    public LocalFolder LocalFolder { get; set; } = null!;

    public Guid SessionId { get; set; }

    public int BackgroundJobId { get; set; }
    public BackgroundJob BackgroundJob { get; set; } = null!;

    public LocalScanStatus Status { get; set; } = LocalScanStatus.Queued;

    public int FileCount { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedUtc { get; set; }
}

