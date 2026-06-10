using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class WebScanResultConfiguration : IEntityTypeConfiguration<WebScanResult>
{
    public void Configure(EntityTypeBuilder<WebScanResult> entity)
    {
        entity.Property(x => x.Url).HasMaxLength(1000);
        entity.Property(x => x.FileName).HasMaxLength(260);
    }
}
