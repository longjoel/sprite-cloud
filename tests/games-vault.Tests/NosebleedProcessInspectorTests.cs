using games_vault.Nosebleed;

namespace games_vault.Tests;

public sealed class NosebleedProcessInspectorTests
{
    [Fact]
    public void ParseArguments_ParsesKnownNosebleedFlags()
    {
        var parsed = NosebleedProcessInspector.ParseArguments([
            "/opt/nosebleed/nosebleed",
            "--listen", "0.0.0.0:8099",
            "--core", "/cores/mgba.so",
            "--content", "/roms/game.gb",
            "--session-id", "games-vault-1-2-abc",
            "--fps", "60"
        ]);

        Assert.Equal("0.0.0.0:8099", parsed.Listen);
        Assert.Equal("games-vault-1-2-abc", parsed.SessionId);
        Assert.Equal("/cores/mgba.so", parsed.CorePath);
        Assert.Equal("/roms/game.gb", parsed.ContentPath);
    }

    [Fact]
    public void IsNosebleedCommand_MatchesExecutableNameConfiguredPathOrGamesVaultSessionId()
    {
        Assert.True(NosebleedProcessInspector.IsNosebleedCommand(["/usr/local/bin/nosebleed", "--listen", "127.0.0.1:1"], null));
        Assert.True(NosebleedProcessInspector.IsNosebleedCommand(["/tmp/custom-sidecar", "--listen", "127.0.0.1:1"], "/tmp/custom-sidecar"));
        Assert.True(NosebleedProcessInspector.IsNosebleedCommand(["/tmp/unknown", "--session-id", "games-vault-123"], null));
        Assert.False(NosebleedProcessInspector.IsNosebleedCommand(["/tmp/unknown", "--session-id", "other"], null));
    }

    [Fact]
    public void IsKillableNosebleedCommand_RequiresConfiguredPathOrGamesVaultSessionWithExpectedArgs()
    {
        Assert.True(NosebleedProcessInspector.IsKillableNosebleedCommand(["/tmp/custom-sidecar"], "/tmp/custom-sidecar"));
        Assert.True(NosebleedProcessInspector.IsKillableNosebleedCommand([
            "/tmp/unknown",
            "--listen", "127.0.0.1:1",
            "--core", "/cores/mgba.so",
            "--content", "/roms/game.gb",
            "--session-id", "games-vault-123"
        ], null));

        Assert.False(NosebleedProcessInspector.IsKillableNosebleedCommand(["/usr/local/bin/nosebleed", "--listen", "127.0.0.1:1"], null));
        Assert.False(NosebleedProcessInspector.IsKillableNosebleedCommand(["/tmp/unknown", "--session-id", "games-vault-123"], null));
        Assert.False(NosebleedProcessInspector.IsKillableNosebleedCommand([
            "/tmp/unknown",
            "--listen", "127.0.0.1:1",
            "--core", "/cores/mgba.so",
            "--content", "/roms/game.gb",
            "--session-id", "other"
        ], null));
    }

    [Fact]
    public void ExtractPort_ParsesListenPortBestEffort()
    {
        Assert.Equal(8099, NosebleedProcessInspector.ExtractPort("0.0.0.0:8099"));
        Assert.Equal(8099, NosebleedProcessInspector.ExtractPort("8099"));
        Assert.Null(NosebleedProcessInspector.ExtractPort("not-a-port"));
    }

    [Fact]
    public void ProcessSnapshot_HoldsCpuAndMemoryUsage()
    {
        var snapshot = new NosebleedProcessSnapshot(
            42,
            "/opt/nosebleed/nosebleed",
            "/opt/nosebleed/nosebleed --listen 0.0.0.0:8099",
            "games-vault-123",
            "0.0.0.0:8099",
            8099,
            "/cores/mgba.so",
            "/roms/game.gb",
            12.5,
            134_217_728);

        Assert.Equal(12.5, snapshot.AverageCpuPercent);
        Assert.Equal(134_217_728, snapshot.WorkingSetBytes);
    }
}
