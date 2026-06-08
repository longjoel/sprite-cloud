using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ArcadeConfiguration : IEntityTypeConfiguration<global::games_vault.Models.Arcade>
{
    public void Configure(EntityTypeBuilder<global::games_vault.Models.Arcade> entity)
    {
        entity.Property(x => x.Name).HasMaxLength(120);
        entity.Property(x => x.Slug).HasMaxLength(120);
        entity.Property(x => x.Description).HasMaxLength(1000);
        entity.HasIndex(x => x.Slug).IsUnique();
    }
}
