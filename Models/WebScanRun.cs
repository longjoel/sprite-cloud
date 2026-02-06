namespace games_vault.Models;

public enum WebScanStatus
{
    Queued = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3
}

public sealed class WebScanRun
{
    public int Id { get; set; }

    public int WebSourceId { get; set; }
    public WebSource WebSource { get; set; } = null!;

    public Guid SessionId { get; set; }

    public int BackgroundJobId { get; set; }
    public BackgroundJob BackgroundJob { get; set; } = null!;

    public WebScanStatus Status { get; set; } = WebScanStatus.Queued;

    public int LinkCount { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedUtc { get; set; }
}

