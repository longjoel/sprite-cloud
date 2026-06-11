using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public sealed class ProfilePinnedGameConfiguration : IEntityTypeConfiguration<ProfilePinnedGame>
{
    public void Configure(EntityTypeBuilder<ProfilePinnedGame> builder)
    {
        builder.HasKey(x => x.Id);

        builder.HasIndex(x => new { x.ProfileId, x.GameId })
            .IsUnique()
            .HasFilter("NOT \"IsArchived\"");

        builder.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
