using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public sealed class ProfileCorePreferenceConfiguration : IEntityTypeConfiguration<ProfileCorePreference>
{
    public void Configure(EntityTypeBuilder<ProfileCorePreference> entity)
    {
        entity.Property(x => x.SystemName).HasMaxLength(100);
        entity.Property(x => x.CorePath).HasMaxLength(260);
        entity.Property(x => x.CoreKey).HasMaxLength(100);
        entity.HasIndex(x => new { x.ProfileId, x.SystemName }).IsUnique();

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
