using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GameFileConfiguration : IEntityTypeConfiguration<GameFile>
{
    public void Configure(EntityTypeBuilder<GameFile> entity)
    {
        entity.Property(x => x.Name).HasMaxLength(260);
        entity.Property(x => x.OriginalFileName).HasMaxLength(260);
        entity.Property(x => x.Crc32).HasMaxLength(8);
        entity.Property(x => x.StoragePath).HasMaxLength(1000);
        entity.Property(x => x.ExternalPath).HasMaxLength(2000);

        entity.HasIndex(x => x.Crc32);

        entity.HasOne(x => x.Game)
            .WithMany(x => x.Files)
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
