using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class NetworkShareConfiguration : IEntityTypeConfiguration<NetworkShare>
{
    public void Configure(EntityTypeBuilder<NetworkShare> entity)
    {
        entity.Property(x => x.Name).HasMaxLength(100);
        entity.Property(x => x.RootPath).HasMaxLength(500);
        entity.Property(x => x.Username).HasMaxLength(200);
        entity.Property(x => x.Password).HasMaxLength(500);
    }
}
