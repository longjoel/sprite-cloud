using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ProfileGameSaveRevisionConfiguration : IEntityTypeConfiguration<ProfileGameSaveRevision>
{
    public void Configure(EntityTypeBuilder<ProfileGameSaveRevision> entity)
    {
        entity.Property(x => x.StoragePath).HasMaxLength(1000);
        entity.Property(x => x.Sha256).HasMaxLength(64);
        entity.Property(x => x.Source).HasMaxLength(20);
        entity.Property(x => x.OriginalUploadFileName).HasMaxLength(260);

        entity.HasOne(x => x.GamePlaySession)
            .WithMany()
            .HasForeignKey(x => x.GamePlaySessionId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasIndex(x => new { x.ProfileGameSaveId, x.RevisionTimestampUtc });
    }
}
