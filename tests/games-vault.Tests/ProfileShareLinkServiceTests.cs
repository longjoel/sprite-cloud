using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class ProfileShareLinkServiceTests
{
    [Fact]
    public async Task CreateAsync_CreatesSingleUseShareLinkForRoomWithoutPersistingRawToken()
    {
        await using var fixture = await CreateFixtureAsync();
        var localProfiles = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        var room = await fixture.CreateRoomAsync(host.Id);
        var service = fixture.CreateShareLinkService();

        var created = await service.CreateAsync(room.Id, host.Id, RoomShareGrantMode.Player, CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(created.RawToken));
        Assert.Equal(RoomShareGrantMode.Player, created.ShareLink.GrantMode);
        Assert.Equal(1, created.ShareLink.MaxUses);
        Assert.Equal(0, created.ShareLink.UseCount);
        Assert.NotEqual(created.RawToken, created.ShareLink.TokenHash);
        Assert.Equal(host.Id, created.ShareLink.CreatedByProfileId);
        Assert.Equal(host.Id, created.ShareLink.ParentProfileId);
        Assert.Equal(room.Id, created.ShareLink.RoomId);
    }

    [Fact]
    public async Task RedeemAsync_CreatesEphemeralChildProfileAndConsumesOneTimeLink()
    {
        await using var fixture = await CreateFixtureAsync();
        var localProfiles = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        var room = await fixture.CreateRoomAsync(host.Id);
        var service = fixture.CreateShareLinkService();
        var created = await service.CreateAsync(room.Id, host.Id, RoomShareGrantMode.Spectator, CancellationToken.None);

        fixture.HttpContext.Response.Headers.Clear();

        var redeemed = await service.RedeemAsync(created.RawToken, CancellationToken.None);

        Assert.Equal(RoomShareGrantMode.Spectator, redeemed.ShareLink.GrantMode);
        Assert.NotNull(redeemed.Profile);
        Assert.True(redeemed.Profile!.IsEphemeral);
        Assert.Equal(host.Id, redeemed.Profile.ParentProfileId);
        Assert.Equal(redeemed.Profile.Id, redeemed.ShareLink.RedeemedByProfileId);
        Assert.Equal(1, redeemed.ShareLink.UseCount);
        Assert.NotNull(redeemed.ShareLink.LastUsedUtc);
        Assert.Contains($"{CurrentProfileService.CookieName}={redeemed.Profile.Id}", fixture.HttpContext.Response.Headers.SetCookie.ToString());

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.RedeemAsync(created.RawToken, CancellationToken.None));
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
        var httpContext = new DefaultHttpContext();
        var accessor = new TestHttpContextAccessor(httpContext);
        return new TestFixture(connection, db, httpContext, accessor);
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed record TestFixture(SqliteConnection Connection, AppDbContext Db, DefaultHttpContext HttpContext, IHttpContextAccessor HttpContextAccessor) : IAsyncDisposable
    {
        public ProfileShareLinkService CreateShareLinkService()
        {
            var currentProfile = new CurrentProfileService(Db, HttpContextAccessor);
            var localProfiles = new LocalProfileService(Db, currentProfile);
            return new ProfileShareLinkService(Db, localProfiles);
        }

        public async Task<GamePlayRoom> CreateRoomAsync(int createdByProfileId)
        {
            var game = new Game { Name = "Sonic", SystemName = "Sega - Game Gear" };
            var file = new GameFile { Game = game, Name = "sonic.gg", StoragePath = "/tmp/sonic.gg" };
            var room = new GamePlayRoom
            {
                Code = "ABCD",
                Game = game,
                GameFile = file,
                CreatedByProfileId = createdByProfileId,
                Status = GamePlayRoomStatus.Active,
                NosebleedSessionId = "session-1"
            };

            Db.GamePlayRooms.Add(room);
            await Db.SaveChangesAsync();
            return room;
        }

        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
