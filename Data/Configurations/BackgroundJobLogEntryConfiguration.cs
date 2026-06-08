using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class BackgroundJobLogEntryConfiguration : IEntityTypeConfiguration<BackgroundJobLogEntry>
{
    public void Configure(EntityTypeBuilder<BackgroundJobLogEntry> entity)
    {
        entity.Property(x => x.Level).HasMaxLength(20);
        entity.Property(x => x.Message).HasMaxLength(4000);

        entity.HasOne(x => x.BackgroundJob)
            .WithMany()
            .HasForeignKey(x => x.BackgroundJobId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
