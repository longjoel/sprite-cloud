using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public enum RoomShareGrantMode
{
    Spectator = 0,
    Player = 1
}

public sealed class ProfileShareLink
{
    public int Id { get; set; }

    [Required]
    [StringLength(128)]
    public string TokenHash { get; set; } = string.Empty;

    public int RoomId { get; set; }
    public GamePlayRoom Room { get; set; } = null!;

    public int GameId { get; set; }
    public Game Game { get; set; } = null!;

    public int CreatedByProfileId { get; set; }
    public UserProfile CreatedByProfile { get; set; } = null!;

    public int ParentProfileId { get; set; }
    public UserProfile ParentProfile { get; set; } = null!;

    public RoomShareGrantMode GrantMode { get; set; } = RoomShareGrantMode.Spectator;

    public int MaxUses { get; set; } = 1;
    public int UseCount { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
    public DateTime? RevokedUtc { get; set; }

    public int? RedeemedByProfileId { get; set; }
    public UserProfile? RedeemedByProfile { get; set; }

    public bool IsRevoked => RevokedUtc is not null;
    public bool IsExpired => ExpiresUtc <= DateTime.UtcNow;
}
