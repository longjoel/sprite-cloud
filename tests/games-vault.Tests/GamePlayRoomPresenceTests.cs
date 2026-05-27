using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Nosebleed;

namespace games_vault.Tests;

public sealed class GamePlayRoomPresenceTests
{
    [Fact]
    public void BuildPresenceSnapshot_ReturnsNamedPlayersWatcherCountAndTotalConnected()
    {
        var seats = new[]
        {
            new NosebleedSeatAssignment(NosebleedSeatKind.Player, "viewer-a", 1, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(1)),
            new NosebleedSeatAssignment(NosebleedSeatKind.Spectator, "viewer-b", null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(1)),
            new NosebleedSeatAssignment(NosebleedSeatKind.Player, "viewer-c", 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(1))
        };
        var participants = new[]
        {
            new GamePlayRoomParticipant { ViewerId = "viewer-a", DisplayNameSnapshot = "Alice", ProfileId = 1 },
            new GamePlayRoomParticipant { ViewerId = "viewer-b", DisplayNameSnapshot = null, ProfileId = null },
            new GamePlayRoomParticipant { ViewerId = "viewer-c", DisplayNameSnapshot = "Carol", ProfileId = 2 }
        };

        var snapshot = GamePlayRoomService.BuildPresenceSnapshot(seats, participants);

        Assert.Equal(2, snapshot.Players.Count);
        Assert.Equal("Carol", snapshot.Players[0].DisplayName);
        Assert.Equal(1, snapshot.Players[0].PlayerNumber);
        Assert.Equal("Alice", snapshot.Players[1].DisplayName);
        Assert.Equal(2, snapshot.Players[1].PlayerNumber);
        Assert.Equal(1, snapshot.WatcherCount);
        Assert.Equal(3, snapshot.TotalConnected);
    }
}
