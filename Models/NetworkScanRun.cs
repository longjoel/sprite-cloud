namespace games_vault.Models;

public enum NetworkScanStatus
{
    Queued = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3
}

public class NetworkScanRun
{
    public int Id { get; set; }

    public int NetworkShareId { get; set; }
    public NetworkShare NetworkShare { get; set; } = null!;

    public Guid SessionId { get; set; }

    public int BackgroundJobId { get; set; }
    public BackgroundJob BackgroundJob { get; set; } = null!;

    public NetworkScanStatus Status { get; set; } = NetworkScanStatus.Queued;

    public int FileCount { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedUtc { get; set; }
}

