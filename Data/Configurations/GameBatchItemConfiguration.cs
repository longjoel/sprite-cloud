using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GameBatchItemConfiguration : IEntityTypeConfiguration<GameBatchItem>
{
    public void Configure(EntityTypeBuilder<GameBatchItem> entity)
    {
        entity.HasKey(x => new { x.GameBatchId, x.GameId });

        entity.HasOne(x => x.GameBatch)
            .WithMany(x => x.Items)
            .HasForeignKey(x => x.GameBatchId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
