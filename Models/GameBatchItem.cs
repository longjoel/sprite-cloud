namespace games_vault.Models;

public sealed class GameBatchItem
{
    public int GameBatchId { get; set; }
    public GameBatch GameBatch { get; set; } = null!;

    public int GameId { get; set; }
    public Game Game { get; set; } = null!;

    public DateTime AddedUtc { get; set; } = DateTime.UtcNow;
}

