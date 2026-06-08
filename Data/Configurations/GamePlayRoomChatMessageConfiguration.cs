using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GamePlayRoomChatMessageConfiguration : IEntityTypeConfiguration<GamePlayRoomChatMessage>
{
    public void Configure(EntityTypeBuilder<GamePlayRoomChatMessage> entity)
    {
        entity.Property(x => x.DisplayNameSnapshot).HasMaxLength(80);
        entity.Property(x => x.Message).HasMaxLength(280);

        entity.HasOne(x => x.Room)
            .WithMany(x => x.ChatMessages)
            .HasForeignKey(x => x.RoomId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasIndex(x => new { x.RoomId, x.CreatedUtc });
    }
}
