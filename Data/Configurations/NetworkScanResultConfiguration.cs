using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class NetworkScanResultConfiguration : IEntityTypeConfiguration<NetworkScanResult>
{
    public void Configure(EntityTypeBuilder<NetworkScanResult> entity)
    {
        entity.Property(x => x.FullPath).HasMaxLength(1000);
        entity.Property(x => x.FileName).HasMaxLength(260);

        entity.HasOne(x => x.NetworkScanRun)
            .WithMany()
            .HasForeignKey(x => x.NetworkScanRunId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
