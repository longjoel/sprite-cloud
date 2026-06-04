using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class ProfileGameSave
{
    public int Id { get; set; }

    [Required]
    public int ProfileId { get; set; }
    public UserProfile Profile { get; set; } = null!;

    [Required]
    public int GameId { get; set; }
    public Game Game { get; set; } = null!;

    [Required]
    public int GameFileId { get; set; }
    public GameFile GameFile { get; set; } = null!;

    [Required]
    [StringLength(100)]
    public string SystemName { get; set; } = "";

    [StringLength(100)]
    public string? CoreKey { get; set; }

    [Required]
    [StringLength(50)]
    public string Kind { get; set; } = "battery";

    [Required]
    [StringLength(200)]
    public string Key { get; set; } = "default";

    [Required]
    [StringLength(260)]
    public string FileName { get; set; } = "";

    public int? LatestRevisionId { get; set; }
    public ProfileGameSaveRevision? LatestRevision { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;

    public ICollection<ProfileGameSaveRevision> Revisions { get; set; } = [];
}
