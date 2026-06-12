using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ArcadeCabinetConfiguration : IEntityTypeConfiguration<ArcadeCabinet>
{
    public void Configure(EntityTypeBuilder<ArcadeCabinet> entity)
    {
        entity.Property(x => x.DisplayName).HasMaxLength(120);
        entity.Property(x => x.RuntimeSessionId).HasMaxLength(200);
        entity.Property(x => x.LastError).HasMaxLength(1000);

        entity.HasOne(x => x.Arcade)
            .WithMany(x => x.Cabinets)
            .HasForeignKey(x => x.ArcadeId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.GameFile)
            .WithMany()
            .HasForeignKey(x => x.GameFileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasIndex(x => new { x.ArcadeId, x.SortOrder });
        entity.HasIndex(x => x.RuntimeSessionId);
    }
}
