using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class UserProfilePasskey
{
    public int Id { get; set; }

    public int ProfileId { get; set; }

    public UserProfile Profile { get; set; } = null!;

    [Required]
    [StringLength(512)]
    public string CredentialIdBase64Url { get; set; } = "";

    [Required]
    public byte[] PublicKey { get; set; } = [];

    [Required]
    [StringLength(128)]
    public string UserHandleBase64Url { get; set; } = "";

    public uint SignatureCounter { get; set; }

    [StringLength(200)]
    public string? DeviceName { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime? LastUsedUtc { get; set; }
}
