using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class ProfileCorePreference
{
    public int Id { get; set; }

    public int ProfileId { get; set; }
    public UserProfile Profile { get; set; } = null!;

    [Required]
    [StringLength(100)]
    public string SystemName { get; set; } = "";

    [StringLength(260)]
    public string? CorePath { get; set; }

    [StringLength(100)]
    public string? CoreKey { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;
}
