using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ProfileAuthSessionConfiguration : IEntityTypeConfiguration<ProfileAuthSession>
{
    public void Configure(EntityTypeBuilder<ProfileAuthSession> entity)
    {
        entity.Property(x => x.SessionNonce).HasMaxLength(64);
        entity.Property(x => x.UserAgentHash).HasMaxLength(128);

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasIndex(x => x.SessionNonce).IsUnique();
        entity.HasIndex(x => x.ProfileId)
            .HasFilter("\"RevokedUtc\" IS NULL")
            .IsUnique();
        entity.HasIndex(x => new { x.ProfileId, x.RevokedUtc });
    }
}
