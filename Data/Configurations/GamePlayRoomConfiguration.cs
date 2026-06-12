using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GamePlayRoomConfiguration : IEntityTypeConfiguration<GamePlayRoom>
{
    public void Configure(EntityTypeBuilder<GamePlayRoom> entity)
    {
        entity.Property(x => x.Code).HasMaxLength(6);
        entity.Property(x => x.NosebleedSessionId).HasMaxLength(200);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.GameFile)
            .WithMany()
            .HasForeignKey(x => x.GameFileId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.CreatedByProfile)
            .WithMany()
            .HasForeignKey(x => x.CreatedByProfileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasOne(x => x.ArcadeCabinet)
            .WithMany()
            .HasForeignKey(x => x.ArcadeCabinetId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasIndex(x => new { x.Code, x.Status }).IsUnique();
        entity.HasIndex(x => x.NosebleedSessionId);
        entity.HasIndex(x => new { x.GameId, x.GameFileId, x.Status });
    }
}
