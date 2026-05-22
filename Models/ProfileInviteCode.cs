using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class ProfileInviteCode
{
    public int Id { get; set; }

    [Required]
    [StringLength(64)]
    public string Code { get; set; } = "";

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime? UsedUtc { get; set; }

    public int? UsedByProfileId { get; set; }

    public UserProfile? UsedByProfile { get; set; }

    public bool IsUsed => UsedUtc is not null;
}
