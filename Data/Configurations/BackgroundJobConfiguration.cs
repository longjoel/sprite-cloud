using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class BackgroundJobConfiguration : IEntityTypeConfiguration<BackgroundJob>
{
    public void Configure(EntityTypeBuilder<BackgroundJob> entity)
    {
        entity.Property(x => x.Command).HasMaxLength(200);
        entity.Property(x => x.LockedBy).HasMaxLength(100);
    }
}
