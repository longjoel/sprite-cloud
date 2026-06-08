using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class SystemCoreMappingConfiguration : IEntityTypeConfiguration<SystemCoreMapping>
{
    public void Configure(EntityTypeBuilder<SystemCoreMapping> entity)
    {
        entity.Property(x => x.SystemName).HasMaxLength(100);
        entity.Property(x => x.NativeCoreFileName).HasMaxLength(260);
        entity.Property(x => x.WebPlayerCoreKey).HasMaxLength(100);
        entity.Property(x => x.Notes).HasMaxLength(1000);
        entity.HasIndex(x => x.SystemName).IsUnique();
    }
}
