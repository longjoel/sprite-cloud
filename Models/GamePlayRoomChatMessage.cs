using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class GamePlayRoomChatMessage
{
    public int Id { get; set; }

    public int RoomId { get; set; }
    public GamePlayRoom Room { get; set; } = null!;

    public int? ProfileId { get; set; }
    public UserProfile? Profile { get; set; }

    [StringLength(80)]
    public string? DisplayNameSnapshot { get; set; }

    [Required]
    [StringLength(280)]
    public string Message { get; set; } = string.Empty;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
