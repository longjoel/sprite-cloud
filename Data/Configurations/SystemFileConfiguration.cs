using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class SystemFileConfiguration : IEntityTypeConfiguration<SystemFile>
{
    public void Configure(EntityTypeBuilder<SystemFile> entity)
    {
        entity.Property(x => x.SystemName).HasMaxLength(100);
        entity.Property(x => x.Kind).HasMaxLength(30);
        entity.Property(x => x.FileName).HasMaxLength(260);
        entity.Property(x => x.TargetPath).HasMaxLength(500);
        entity.Property(x => x.OriginalFileName).HasMaxLength(260);
        entity.Property(x => x.Crc32).HasMaxLength(8);
        entity.Property(x => x.StoragePath).HasMaxLength(1000);
    }
}
