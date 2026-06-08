using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class ArtifactConfiguration : IEntityTypeConfiguration<Artifact>
{
    public void Configure(EntityTypeBuilder<Artifact> entity)
    {
        entity.Property(x => x.FileName).HasMaxLength(260);
        entity.Property(x => x.StoragePath).HasMaxLength(1000);
        entity.Property(x => x.ContentType).HasMaxLength(200);
        entity.Property(x => x.Source).HasMaxLength(200);
    }
}
