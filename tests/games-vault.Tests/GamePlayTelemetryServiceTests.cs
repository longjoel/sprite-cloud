using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Models;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class GamePlayTelemetryServiceTests
{
    [Fact]
    public async Task StartAsync_ReusesActiveSessionForSameExternalSessionId()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new GamePlayTelemetryService(fixture.Db);

        var first = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "ext-1", CancellationToken.None);
        var second = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "ext-1", CancellationToken.None);

        Assert.Equal(first.Id, second.Id);
        Assert.Single(await fixture.Db.GamePlaySessions.ToListAsync());
        Assert.Null(second.EndedUtc);
    }

    [Fact]
    public async Task FinishByExternalSessionAsync_EndsActiveSessionAndStoresDurationAndReason()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new GamePlayTelemetryService(fixture.Db);
        var started = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "ext-2", CancellationToken.None);
        started.StartedUtc = DateTime.UtcNow.AddSeconds(-90);
        await fixture.Db.SaveChangesAsync();

        var finished = await service.FinishByExternalSessionAsync("ext-2", "manual", CancellationToken.None);

        Assert.True(finished);
        var session = await fixture.Db.GamePlaySessions.SingleAsync();
        Assert.Equal("manual", session.EndReason);
        Assert.NotNull(session.EndedUtc);
        Assert.InRange(session.DurationSeconds, 80, 120);
    }

    [Fact]
    public async Task TouchDurationAsync_UpdatesActiveSessionDurationWithoutEndingIt()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new GamePlayTelemetryService(fixture.Db);
        var started = await service.StartAsync(fixture.Game.Id, null, "web", "ext-3", CancellationToken.None);
        started.StartedUtc = DateTime.UtcNow.AddSeconds(-42);
        await fixture.Db.SaveChangesAsync();

        var touched = await service.TouchDurationAsync("ext-3", CancellationToken.None);

        Assert.True(touched);
        var session = await fixture.Db.GamePlaySessions.SingleAsync();
        Assert.Null(session.EndedUtc);
        Assert.InRange(session.DurationSeconds, 30, 60);
    }

    [Fact]
    public async Task GetDashboardStatsAsync_ComputesTotalsAndActiveDurations()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new GamePlayTelemetryService(fixture.Db);
        var active = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "active", CancellationToken.None);
        active.StartedUtc = DateTime.UtcNow.AddSeconds(-30);
        fixture.Db.GamePlaySessions.Add(new GamePlaySession
        {
            GameId = fixture.Game.Id,
            GameFileId = fixture.File.Id,
            Mode = "web",
            ExternalSessionId = "finished",
            StartedUtc = DateTime.UtcNow.AddMinutes(-10),
            EndedUtc = DateTime.UtcNow.AddMinutes(-8),
            DurationSeconds = 120,
            EndReason = "done"
        });
        await fixture.Db.SaveChangesAsync();

        var stats = await service.GetDashboardStatsAsync(CancellationToken.None);

        Assert.Equal(2, stats.TotalSessions);
        Assert.Equal(1, stats.ActiveSessions);
        Assert.True(stats.TotalDurationSeconds >= 145);
        Assert.Contains(stats.ByMode, x => x.Mode == "nosebleed" && x.ActiveSessions == 1);
        Assert.Contains(stats.ByMode, x => x.Mode == "web" && x.TotalSessions == 1);
    }

    [Fact]
    public async Task ReconcileActiveExternalSessionsAsync_EndsMissingActiveExternalSessionsForModeOnly()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new GamePlayTelemetryService(fixture.Db);
        var stale = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "stale", CancellationToken.None);
        var active = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "active", CancellationToken.None);
        var web = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "web", "web-stale", CancellationToken.None);
        stale.StartedUtc = DateTime.UtcNow.AddSeconds(-75);
        active.StartedUtc = DateTime.UtcNow.AddSeconds(-30);
        web.StartedUtc = DateTime.UtcNow.AddSeconds(-90);
        await fixture.Db.SaveChangesAsync();

        var reconciled = await service.ReconcileActiveExternalSessionsAsync(
            "nosebleed",
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "active" },
            "process-exit",
            CancellationToken.None);

        Assert.Equal(1, reconciled);
        var sessions = await fixture.Db.GamePlaySessions.ToDictionaryAsync(x => x.ExternalSessionId!);
        Assert.Equal("process-exit", sessions["stale"].EndReason);
        Assert.NotNull(sessions["stale"].EndedUtc);
        Assert.Null(sessions["active"].EndedUtc);
        Assert.Null(sessions["web-stale"].EndedUtc);
    }

    [Fact]
    public async Task DeletingGame_CascadesToGamePlaySessions()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new GamePlayTelemetryService(fixture.Db);
        await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "delete-me", CancellationToken.None);

        fixture.Db.Games.Remove(fixture.Game);
        await fixture.Db.SaveChangesAsync();

        Assert.Empty(await fixture.Db.GamePlaySessions.ToListAsync());
    }

    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(connection)
            .Options;
        var db = new AppDbContext(options);
        await db.Database.EnsureCreatedAsync();
        var game = new Game { Name = "Game", SystemName = "gb", SizeBytes = 1 };
        var file = new GameFile { Game = game, Name = "game.gb", SizeBytes = 1 };
        db.Games.Add(game);
        db.GameFiles.Add(file);
        await db.SaveChangesAsync();
        return new TestFixture(connection, db, game, file);
    }

    private sealed record TestFixture(SqliteConnection Connection, AppDbContext Db, Game Game, GameFile File) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
