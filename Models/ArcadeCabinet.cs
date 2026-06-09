using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public enum ArcadeCabinetCreditMode
{
    FreePlay = 0,
    TokenPerCredit = 1
}

public class ArcadeCabinet
{
    public int Id { get; set; }
    public int ArcadeId { get; set; }
    public Arcade Arcade { get; set; } = null!;

    public int GameId { get; set; }
    public Game Game { get; set; } = null!;

    public int? GameFileId { get; set; }
    public GameFile? GameFile { get; set; }

    [StringLength(120)]
    public string DisplayName { get; set; } = "Cabinet";
    public int SortOrder { get; set; }
    public bool IsEnabled { get; set; } = true;
    public bool AutoRestart { get; set; } = true;
    public ArcadeCabinetCreditMode CreditMode { get; set; } = ArcadeCabinetCreditMode.FreePlay;
    public int TokenCostPerCredit { get; set; } = 0;

    [StringLength(200)]
    public string? RuntimeSessionId { get; set; }
    public DateTimeOffset? LastStartedUtc { get; set; }
    public DateTimeOffset? LastSeenAliveUtc { get; set; }

    [StringLength(1000)]
    public string? LastError { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedUtc { get; set; }
}
