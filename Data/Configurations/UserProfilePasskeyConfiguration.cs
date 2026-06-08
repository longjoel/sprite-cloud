using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class UserProfilePasskeyConfiguration : IEntityTypeConfiguration<UserProfilePasskey>
{
    public void Configure(EntityTypeBuilder<UserProfilePasskey> entity)
    {
        entity.Property(x => x.CredentialIdBase64Url).HasMaxLength(512);
        entity.Property(x => x.UserHandleBase64Url).HasMaxLength(128);
        entity.Property(x => x.DeviceName).HasMaxLength(200);
        entity.HasIndex(x => x.CredentialIdBase64Url).IsUnique();
        entity.HasIndex(x => x.UserHandleBase64Url);

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
