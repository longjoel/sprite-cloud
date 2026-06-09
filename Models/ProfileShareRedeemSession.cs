using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

/// <summary>
/// A short-lived, single-use session that maps a share link URL parameter
/// (session code) to an actual ProfileShareLink, keeping the raw token
/// out of the URL and preventing referer-leak, access-log leakage, etc.
/// </summary>
public sealed class ProfileShareRedeemSession
{
    public int Id { get; set; }

    public int ProfileShareLinkId { get; set; }
    public ProfileShareLink ShareLink { get; set; } = null!;

    /// <summary>
    /// Opaque one-time code placed in the share URL instead of the raw token.
    /// 32 hex chars = 16 random bytes.
    /// </summary>
    [Required]
    [StringLength(64)]
    public string SessionCode { get; set; } = string.Empty;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime ExpiresUtc { get; set; }

    /// <summary>
    /// Set when the session is first consumed (RedeemBySessionCodeAsync).
    /// Once consumed, the code cannot be reused.
    /// </summary>
    public DateTime? ConsumedUtc { get; set; }

    public bool IsExpired => ExpiresUtc <= DateTime.UtcNow;
    public bool IsConsumed => ConsumedUtc is not null;
}
