using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public class GamePlayRoomParticipantConfiguration : IEntityTypeConfiguration<GamePlayRoomParticipant>
{
    public void Configure(EntityTypeBuilder<GamePlayRoomParticipant> entity)
    {
        entity.Property(x => x.ViewerId).HasMaxLength(64);
        entity.Property(x => x.DisplayNameSnapshot).HasMaxLength(80);

        entity.HasOne(x => x.Room)
            .WithMany(x => x.Participants)
            .HasForeignKey(x => x.RoomId)
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.SetNull);

        entity.HasIndex(x => new { x.RoomId, x.ViewerId }).IsUnique();
        entity.HasIndex(x => new { x.RoomId, x.IsConnected });
    }
}
