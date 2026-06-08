using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GameConfiguration : IEntityTypeConfiguration<Game>
{
    public void Configure(EntityTypeBuilder<Game> entity)
    {
        entity.Property(x => x.SystemName).HasMaxLength(100);
        entity.Property(x => x.Name).HasMaxLength(200);
        entity.Property(x => x.Crc32).HasMaxLength(8);
        entity.Property(x => x.Genre).HasMaxLength(100);
        entity.Property(x => x.CriticGenre).HasMaxLength(100);
        entity.Property(x => x.CriticRating).HasPrecision(5, 2);
        entity.Property(x => x.UserRating).HasPrecision(5, 2);
    }
}
