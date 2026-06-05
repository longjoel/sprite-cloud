using games_vault.Nosebleed;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class NosebleedSeatManagerTests
{
    [Fact]
    public void Assign_GivesFirstFourViewersSequentialPorts()
    {
        var manager = CreateManager(maxPlayers: 4, ttlMinutes: 30);
        var now = DateTimeOffset.UtcNow;

        Assert.Equal(0, manager.Assign("s1", "v1", now).Port);
        Assert.Equal(1, manager.Assign("s1", "v2", now).Port);
        Assert.Equal(2, manager.Assign("s1", "v3", now).Port);
        Assert.Equal(3, manager.Assign("s1", "v4", now).Port);
    }

    [Fact]
    public void Assign_MakesFifthUniqueViewerSpectator()
    {
        var manager = CreateManager(maxPlayers: 4, ttlMinutes: 30);
        var now = DateTimeOffset.UtcNow;

        manager.Assign("s1", "v1", now);
        manager.Assign("s1", "v2", now);
        manager.Assign("s1", "v3", now);
        manager.Assign("s1", "v4", now);
        var fifth = manager.Assign("s1", "v5", now);

        Assert.Equal(NosebleedSeatKind.Spectator, fifth.Kind);
        Assert.Null(fifth.Port);
        Assert.Null(fifth.PlayerNumber);
    }

    [Fact]
    public void Assign_PreservesSameViewerPortOnRefresh()
    {
        var manager = CreateManager(maxPlayers: 4, ttlMinutes: 30);
        var now = DateTimeOffset.UtcNow;

        var first = manager.Assign("s1", "v1", now);
        manager.Assign("s1", "v2", now);
        var refreshed = manager.Assign("s1", "v1", now.AddMinutes(5));

        Assert.Equal(NosebleedSeatKind.Player, refreshed.Kind);
        Assert.Equal(first.Port, refreshed.Port);
        Assert.True(refreshed.ExpiresUtc > first.ExpiresUtc);
    }

    [Fact]
    public void Assign_ReusesExpiredSeatPortForNextViewer()
    {
        var manager = CreateManager(maxPlayers: 1, ttlMinutes: 1);
        var now = DateTimeOffset.UtcNow;

        Assert.Equal(0, manager.Assign("s1", "v1", now).Port);
        var replacement = manager.Assign("s1", "v2", now.AddMinutes(2));

        Assert.Equal(NosebleedSeatKind.Player, replacement.Kind);
        Assert.Equal(0, replacement.Port);
    }

    [Fact]
    public void Release_FreesSeatPortForNextViewer()
    {
        var manager = CreateManager(maxPlayers: 1, ttlMinutes: 30);
        var now = DateTimeOffset.UtcNow;

        Assert.Equal(0, manager.Assign("s1", "v1", now).Port);
        manager.Release("s1", "v1");
        var replacement = manager.Assign("s1", "v2", now.AddSeconds(1));

        Assert.Equal(NosebleedSeatKind.Player, replacement.Kind);
        Assert.Equal(0, replacement.Port);
    }

    [Fact]
    public void Assign_PromotesExistingSpectatorWhenSeatFrees()
    {
        var manager = CreateManager(maxPlayers: 1, ttlMinutes: 30);
        var now = DateTimeOffset.UtcNow;

        Assert.Equal(0, manager.Assign("s1", "v1", now).Port);
        var spectator = manager.Assign("s1", "v2", now);
        Assert.Equal(NosebleedSeatKind.Spectator, spectator.Kind);

        manager.Release("s1", "v1");
        var promoted = manager.Assign("s1", "v2", now.AddSeconds(1));

        Assert.Equal(NosebleedSeatKind.Player, promoted.Kind);
        Assert.Equal(0, promoted.Port);
    }

    [Fact]
    public void GetAssignments_ReturnsOnlyActiveSeatsInPlayerThenSpectatorOrder()
    {
        var manager = CreateManager(maxPlayers: 2, ttlMinutes: 1);
        var now = DateTimeOffset.UtcNow;

        manager.Assign("s1", "player-one", now);
        manager.Assign("s1", "player-two", now);
        var spectator = manager.Assign("s1", "spectator", now);
        Assert.Equal(NosebleedSeatKind.Spectator, spectator.Kind);

        var active = manager.GetAssignments("s1", now.AddSeconds(10)).ToList();

        Assert.Equal(3, active.Count);
        Assert.Equal("player-one", active[0].ViewerId);
        Assert.Equal(0, active[0].Port);
        Assert.Equal("player-two", active[1].ViewerId);
        Assert.Equal(1, active[1].Port);
        Assert.Equal("spectator", active[2].ViewerId);
        Assert.Null(active[2].Port);
    }

    [Fact]
    public void Kick_RemovesPlayerSeatAndKeepsViewerSpectatingUntilRelease()
    {
        var manager = CreateManager(maxPlayers: 2, ttlMinutes: 30);
        var now = DateTimeOffset.UtcNow;

        var first = manager.Assign("s1", "v1", now);
        var second = manager.Assign("s1", "v2", now);
        Assert.Equal(0, first.Port);
        Assert.Equal(1, second.Port);

        manager.Kick("s1", "v2");
        var afterKick = manager.Assign("s1", "v2", now.AddSeconds(1));

        Assert.Equal(NosebleedSeatKind.Spectator, afterKick.Kind);
        Assert.Null(afterKick.Port);
        Assert.Single(manager.GetAssignments("s1", now.AddSeconds(2)), x => x.Kind == NosebleedSeatKind.Player);

        manager.Release("s1", "v2");
        var afterRelease = manager.Assign("s1", "v2", now.AddSeconds(3));

        Assert.Equal(NosebleedSeatKind.Player, afterRelease.Kind);
        Assert.Equal(1, afterRelease.Port);
    }

    private static NosebleedSeatManager CreateManager(int maxPlayers, int ttlMinutes) => new(
        Options.Create(new NosebleedOptions
        {
            MaxPlayersPerSession = maxPlayers,
            SeatTtlMinutes = ttlMinutes
        }));
}
