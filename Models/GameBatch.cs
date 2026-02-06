using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class GameBatch
{
    public int Id { get; set; }

    [Required]
    [StringLength(100)]
    public string Name { get; set; } = "";

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime? UpdatedUtc { get; set; }

    public ICollection<GameBatchItem> Items { get; set; } = new List<GameBatchItem>();
}

