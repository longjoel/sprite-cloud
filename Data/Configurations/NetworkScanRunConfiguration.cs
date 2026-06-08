using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class NetworkScanRunConfiguration : IEntityTypeConfiguration<NetworkScanRun>
{
    public void Configure(EntityTypeBuilder<NetworkScanRun> entity)
    {
        entity.HasOne(x => x.NetworkShare)
            .WithMany()
            .HasForeignKey(x => x.NetworkShareId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.BackgroundJob)
            .WithMany()
            .HasForeignKey(x => x.BackgroundJobId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
