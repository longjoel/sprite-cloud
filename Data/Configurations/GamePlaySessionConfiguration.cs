using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GamePlaySessionConfiguration : IEntityTypeConfiguration<GamePlaySession>
{
    public void Configure(EntityTypeBuilder<GamePlaySession> entity)
    {
        entity.Property(x => x.Mode).HasMaxLength(40);
        entity.Property(x => x.ExternalSessionId).HasMaxLength(200);
        entity.Property(x => x.EndReason).HasMaxLength(100);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.GameFile)
            .WithMany()
            .HasForeignKey(x => x.GameFileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasIndex(x => new { x.GameId, x.StartedUtc });
        entity.HasIndex(x => x.ExternalSessionId);
        entity.HasIndex(x => new { x.Mode, x.StartedUtc });
        entity.HasIndex(x => new { x.ProfileId, x.StartedUtc });
    }
}
