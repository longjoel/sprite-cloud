using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GameBatchConfiguration : IEntityTypeConfiguration<GameBatch>
{
    public void Configure(EntityTypeBuilder<GameBatch> entity)
    {
        entity.Property(x => x.Name).HasMaxLength(100);
    }
}
