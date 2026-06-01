using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class UserProfile
{
    public int Id { get; set; }

    [Required]
    [StringLength(80)]
    public string DisplayName { get; set; } = "";

    [StringLength(32)]
    public string? Username { get; set; }

    [StringLength(32)]
    public string? AvatarKey { get; set; }

    [StringLength(20)]
    public string Color { get; set; } = "#0d6efd";

    [Required]
    [StringLength(128)]
    public string PasskeyUserHandleBase64Url { get; set; } = "";

    [StringLength(256)]
    public string? PasswordHash { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;

    public bool IsArchived { get; set; }

    public bool IsAdmin { get; set; }
}
