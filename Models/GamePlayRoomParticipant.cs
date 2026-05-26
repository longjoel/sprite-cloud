using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public enum GamePlayRoomParticipantRole
{
    Spectator = 0,
    Player = 1
}

public sealed class GamePlayRoomParticipant
{
    public int Id { get; set; }

    public int RoomId { get; set; }
    public GamePlayRoom Room { get; set; } = null!;

    [Required]
    [StringLength(64)]
    public string ViewerId { get; set; } = string.Empty;

    public int? ProfileId { get; set; }
    public UserProfile? Profile { get; set; }

    [StringLength(80)]
    public string? DisplayNameSnapshot { get; set; }

    public GamePlayRoomParticipantRole Role { get; set; } = GamePlayRoomParticipantRole.Spectator;
    public int? Port { get; set; }

    public DateTime JoinedUtc { get; set; } = DateTime.UtcNow;
    public DateTime LastSeenUtc { get; set; } = DateTime.UtcNow;
    public bool IsConnected { get; set; } = true;
}
