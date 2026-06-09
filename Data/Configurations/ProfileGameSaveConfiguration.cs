using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ProfileGameSaveConfiguration : IEntityTypeConfiguration<ProfileGameSave>
{
    public void Configure(EntityTypeBuilder<ProfileGameSave> entity)
    {
        entity.Property(x => x.SystemName).HasMaxLength(100);
        entity.Property(x => x.CoreKey).HasMaxLength(100);
        entity.Property(x => x.Kind).HasMaxLength(50);
        entity.Property(x => x.Key).HasMaxLength(200);
        entity.Property(x => x.FileName).HasMaxLength(260);

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.GameFile)
            .WithMany()
            .HasForeignKey(x => x.GameFileId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.LatestRevision)
            .WithMany()
            .HasForeignKey(x => x.LatestRevisionId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasMany(x => x.Revisions)
            .WithOne(x => x.ProfileGameSave)
            .HasForeignKey(x => x.ProfileGameSaveId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasIndex(x => new { x.ProfileId, x.GameId, x.GameFileId, x.Kind, x.Key, x.FileName, x.CoreKey }).IsUnique();
        entity.HasIndex(x => new { x.ProfileId, x.UpdatedUtc });
    }
}
