using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GamePlayerFileConfiguration : IEntityTypeConfiguration<GamePlayerFile>
{
    public void Configure(EntityTypeBuilder<GamePlayerFile> entity)
    {
        entity.Property(x => x.Kind).HasMaxLength(50);
        entity.Property(x => x.Key).HasMaxLength(100);
        entity.Property(x => x.FileName).HasMaxLength(260);
        entity.Property(x => x.StoragePath).HasMaxLength(1000);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasIndex(x => new { x.GameId, x.Kind, x.Key, x.FileName }).IsUnique();
    }
}
