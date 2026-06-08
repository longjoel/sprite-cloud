using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class WebScanRunConfiguration : IEntityTypeConfiguration<WebScanRun>
{
    public void Configure(EntityTypeBuilder<WebScanRun> entity)
    {
        entity.HasOne(x => x.WebSource)
            .WithMany()
            .HasForeignKey(x => x.WebSourceId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.BackgroundJob)
            .WithMany()
            .HasForeignKey(x => x.BackgroundJobId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
