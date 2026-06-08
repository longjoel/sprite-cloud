using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class UserProfileConfiguration : IEntityTypeConfiguration<UserProfile>
{
    public void Configure(EntityTypeBuilder<UserProfile> entity)
    {
        entity.Property(x => x.DisplayName).HasMaxLength(80);
        entity.Property(x => x.Username).HasMaxLength(32);
        entity.Property(x => x.AvatarKey).HasMaxLength(32);
        entity.Property(x => x.Color).HasMaxLength(20);
        entity.Property(x => x.PasskeyUserHandleBase64Url).HasMaxLength(128);
        entity.Property(x => x.PasswordHash).HasMaxLength(256);
        entity.HasIndex(x => x.DisplayName);
        entity.HasIndex(x => x.Username).IsUnique();
        entity.HasIndex(x => x.PasskeyUserHandleBase64Url).IsUnique();
        entity.HasIndex(x => x.ParentProfileId);
        entity.HasIndex(x => x.CreatedFromShareLinkId);

        entity.HasOne(x => x.ParentProfile)
            .WithMany()
            .HasForeignKey(x => x.ParentProfileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasOne(x => x.CreatedFromShareLink)
            .WithMany()
            .HasForeignKey(x => x.CreatedFromShareLinkId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}
