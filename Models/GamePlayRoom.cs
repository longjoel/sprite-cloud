using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public enum GamePlayRoomStatus
{
    Active = 0,
    Closed = 1
}

public sealed class GamePlayRoom
{
    public int Id { get; set; }

    [Required]
    [StringLength(6)]
    public string Code { get; set; } = string.Empty;

    public int GameId { get; set; }
    public Game Game { get; set; } = null!;

    public int GameFileId { get; set; }
    public GameFile GameFile { get; set; } = null!;

    [StringLength(200)]
    public string? NosebleedSessionId { get; set; }

    public int? CreatedByProfileId { get; set; }
    public UserProfile? CreatedByProfile { get; set; }

    public GamePlayRoomStatus Status { get; set; } = GamePlayRoomStatus.Active;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime LastActiveUtc { get; set; } = DateTime.UtcNow;
    public DateTime? ClosedUtc { get; set; }

    public bool IsArcadeBound { get; set; }
    public int? ArcadeCabinetId { get; set; }
    public ArcadeCabinet? ArcadeCabinet { get; set; }

    public ICollection<GamePlayRoomParticipant> Participants { get; set; } = new List<GamePlayRoomParticipant>();
    public ICollection<GamePlayRoomChatMessage> ChatMessages { get; set; } = new List<GamePlayRoomChatMessage>();
}
