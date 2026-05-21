using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class GamePlaySession
{
    public int Id { get; set; }

    public int GameId { get; set; }

    public int? GameFileId { get; set; }

    public Game Game { get; set; } = null!;

    public GameFile? GameFile { get; set; }

    [Required]
    [StringLength(40)]
    public string Mode { get; set; } = "";

    [StringLength(200)]
    public string? ExternalSessionId { get; set; }

    public DateTime StartedUtc { get; set; } = DateTime.UtcNow;

    public DateTime? EndedUtc { get; set; }

    public int DurationSeconds { get; set; }

    [StringLength(100)]
    public string? EndReason { get; set; }
}
