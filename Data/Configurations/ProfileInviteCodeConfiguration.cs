using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ProfileInviteCodeConfiguration : IEntityTypeConfiguration<ProfileInviteCode>
{
    public void Configure(EntityTypeBuilder<ProfileInviteCode> entity)
    {
        entity.Property(x => x.Code).HasMaxLength(64);
        entity.HasIndex(x => x.Code).IsUnique();

        entity.HasOne(x => x.UsedByProfile)
            .WithMany()
            .HasForeignKey(x => x.UsedByProfileId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}
