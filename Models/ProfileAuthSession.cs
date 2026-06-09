using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class ProfileAuthSession
{
    public int Id { get; set; }

    public int ProfileId { get; set; }
    public UserProfile Profile { get; set; } = null!;

    [Required]
    [StringLength(64)]
    public string SessionNonce { get; set; } = string.Empty;

    [StringLength(128)]
    public string? UserAgentHash { get; set; }

    public DateTime LastSeenUtc { get; set; } = DateTime.UtcNow;
    public DateTime? RevokedUtc { get; set; }

    [Timestamp]
    public byte[]? ConcurrencyToken { get; set; }
}
