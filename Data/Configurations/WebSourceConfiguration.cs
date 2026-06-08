using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class WebSourceConfiguration : IEntityTypeConfiguration<WebSource>
{
    public void Configure(EntityTypeBuilder<WebSource> entity)
    {
        entity.Property(x => x.Name).HasMaxLength(100);
        entity.Property(x => x.IndexUrl).HasMaxLength(1000);
        entity.Property(x => x.AllowedExtensions).HasMaxLength(500);
    }
}
