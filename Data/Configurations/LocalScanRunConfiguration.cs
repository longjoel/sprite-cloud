using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class LocalScanRunConfiguration : IEntityTypeConfiguration<LocalScanRun>
{
    public void Configure(EntityTypeBuilder<LocalScanRun> entity)
    {
        entity.HasOne(x => x.LocalFolder)
            .WithMany()
            .HasForeignKey(x => x.LocalFolderId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.BackgroundJob)
            .WithMany()
            .HasForeignKey(x => x.BackgroundJobId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
