using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class LocalScanResultConfiguration : IEntityTypeConfiguration<LocalScanResult>
{
    public void Configure(EntityTypeBuilder<LocalScanResult> entity)
    {
        entity.Property(x => x.FullPath).HasMaxLength(1000);
        entity.Property(x => x.FileName).HasMaxLength(260);

        entity.HasOne(x => x.LocalScanRun)
            .WithMany()
            .HasForeignKey(x => x.LocalScanRunId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
