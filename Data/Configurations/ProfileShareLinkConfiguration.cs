using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ProfileShareLinkConfiguration : IEntityTypeConfiguration<ProfileShareLink>
{
    public void Configure(EntityTypeBuilder<ProfileShareLink> entity)
    {
        entity.Property(x => x.TokenHash).HasMaxLength(128);
        entity.HasIndex(x => x.TokenHash).IsUnique();
        entity.HasIndex(x => new { x.RoomId, x.CreatedUtc });
        entity.HasIndex(x => new { x.ParentProfileId, x.CreatedUtc });

        entity.HasOne(x => x.Room)
            .WithMany()
            .HasForeignKey(x => x.RoomId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.CreatedByProfile)
            .WithMany()
            .HasForeignKey(x => x.CreatedByProfileId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.ParentProfile)
            .WithMany()
            .HasForeignKey(x => x.ParentProfileId)
            .OnDelete(DeleteBehavior.Restrict);

        entity.HasOne(x => x.RedeemedByProfile)
            .WithMany()
            .HasForeignKey(x => x.RedeemedByProfileId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}
