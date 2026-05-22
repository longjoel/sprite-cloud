using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class SystemCoreMapping
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    [Display(Name = "System")]
    public string SystemName { get; set; } = "";

    [StringLength(260)]
    [Display(Name = "Native core")]
    public string? NativeCoreFileName { get; set; }

    [StringLength(100)]
    [Display(Name = "Web player core")]
    public string? WebPlayerCoreKey { get; set; }

    public bool IsEnabled { get; set; } = true;

    public bool IsAutoMapped { get; set; }

    [StringLength(1000)]
    public string? Notes { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;
}
