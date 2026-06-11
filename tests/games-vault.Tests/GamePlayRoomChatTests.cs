using games_vault.Data;
using Microsoft.Extensions.Caching.Memory;
using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace games_vault.Tests;

public sealed class GamePlayRoomChatTests
{
    [Fact]
    public async Task AddChatMessageAsync_PersistsTrimmedMessageForCurrentProfile()
    {
        await using var fixture = await CreateFixtureAsync();
        var profile = new UserProfile { DisplayName = "Joel", Color = "#198754" };
        var game = new Game { Name = "Sonic", SystemName = "Sega - Game Gear" };
        var file = new GameFile { Game = game, Name = "sonic.gg", StoragePath = "/tmp/sonic.gg" };
        var room = new GamePlayRoom { Code = "ABCD", Game = game, GameFile = file, Status = GamePlayRoomStatus.Active };
        fixture.Db.UserProfiles.Add(profile);
        fixture.Db.GameFiles.Add(file);
        fixture.Db.GamePlayRooms.Add(room);
        await fixture.Db.SaveChangesAsync();
        fixture.HttpContext.Request.Headers.Cookie = $"{CurrentProfileService.CookieName}={profile.Id}";

        var service = CreateService(fixture.Db, fixture.HttpContextAccessor);

        var result = await service.AddChatMessageAsync(room.Id, "  Hello room  ", CancellationToken.None);

        Assert.True(result.Success);
        var message = await fixture.Db.GamePlayRoomChatMessages.SingleAsync();
        Assert.Equal(profile.Id, message.ProfileId);
        Assert.Equal("Joel", message.DisplayNameSnapshot);
        Assert.Equal("Hello room", message.Message);
    }

    [Fact]
    public async Task AddChatMessageAsync_RejectsBlankMessage()
    {
        await using var fixture = await CreateFixtureAsync();
        var profile = new UserProfile { DisplayName = "Joel", Color = "#198754" };
        var game = new Game { Name = "Sonic", SystemName = "Sega - Game Gear" };
        var file = new GameFile { Game = game, Name = "sonic.gg", StoragePath = "/tmp/sonic.gg" };
        var room = new GamePlayRoom { Code = "ABCD", Game = game, GameFile = file, Status = GamePlayRoomStatus.Active };
        fixture.Db.UserProfiles.Add(profile);
        fixture.Db.GameFiles.Add(file);
        fixture.Db.GamePlayRooms.Add(room);
        await fixture.Db.SaveChangesAsync();
        fixture.HttpContext.Request.Headers.Cookie = $"{CurrentProfileService.CookieName}={profile.Id}";

        var service = CreateService(fixture.Db, fixture.HttpContextAccessor);

        var result = await service.AddChatMessageAsync(room.Id, "   ", CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("Enter a chat message.", result.Error);
        Assert.Empty(await fixture.Db.GamePlayRoomChatMessages.ToListAsync());
    }

    [Fact]
    public async Task AddChatMessageAsync_RejectsViewerWithoutProfile()
    {
        await using var fixture = await CreateFixtureAsync();
        var game = new Game { Name = "Sonic", SystemName = "Sega - Game Gear" };
        var file = new GameFile { Game = game, Name = "sonic.gg", StoragePath = "/tmp/sonic.gg" };
        var room = new GamePlayRoom { Code = "ABCD", Game = game, GameFile = file, Status = GamePlayRoomStatus.Active };
        fixture.Db.GameFiles.Add(file);
        fixture.Db.GamePlayRooms.Add(room);
        await fixture.Db.SaveChangesAsync();

        var service = CreateService(fixture.Db, fixture.HttpContextAccessor);

        var result = await service.AddChatMessageAsync(room.Id, "Hello", CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("Sign in with a profile to chat.", result.Error);
        Assert.Empty(await fixture.Db.GamePlayRoomChatMessages.ToListAsync());
    }

    [Fact]
    public async Task AddChatMessageAsync_AllowsEphemeralGuestProfile()
    {
        await using var fixture = await CreateFixtureAsync();
        var parent = new UserProfile { DisplayName = "Joel", Color = "#198754" };
        var game = new Game { Name = "Sonic", SystemName = "Sega - Game Gear" };
        var file = new GameFile { Game = game, Name = "sonic.gg", StoragePath = "/tmp/sonic.gg" };
        var room = new GamePlayRoom { Code = "ABCD", Game = game, GameFile = file, Status = GamePlayRoomStatus.Active };
        fixture.Db.UserProfiles.Add(parent);
        fixture.Db.GameFiles.Add(file);
        fixture.Db.GamePlayRooms.Add(room);
        await fixture.Db.SaveChangesAsync();

        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var guest = await localProfiles.CreateGuestChildAsync(parent.Id, "Guest of Joel", parent.Color, CancellationToken.None);

        var service = CreateService(fixture.Db, fixture.HttpContextAccessor);

        var result = await service.AddChatMessageAsync(room.Id, "hello from guest", CancellationToken.None);

        Assert.True(result.Success);
        var message = await fixture.Db.GamePlayRoomChatMessages.SingleAsync();
        Assert.Equal(guest.Id, message.ProfileId);
        Assert.Equal("Guest of Joel", message.DisplayNameSnapshot);
        Assert.Equal("hello from guest", message.Message);
    }

    [Fact]
    public void BuildChatSnapshot_ReturnsChronologicalMessagesWithDisplayFallback()
    {
        var messages = new[]
        {
            new GamePlayRoomChatMessage
            {
                DisplayNameSnapshot = "Joel",
                Message = "First",
                CreatedUtc = new DateTime(2026, 5, 27, 18, 0, 0, DateTimeKind.Utc)
            },
            new GamePlayRoomChatMessage
            {
                DisplayNameSnapshot = null,
                Message = "Second",
                CreatedUtc = new DateTime(2026, 5, 27, 18, 0, 1, DateTimeKind.Utc)
            }
        };

        var snapshot = GamePlayRoomService.BuildChatSnapshot(messages);

        Assert.Equal(2, snapshot.Messages.Count);
        Assert.Equal("Joel", snapshot.Messages[0].DisplayName);
        Assert.Equal("First", snapshot.Messages[0].Message);
        Assert.Equal("Viewer", snapshot.Messages[1].DisplayName);
        Assert.Equal("Second", snapshot.Messages[1].Message);
    }

    private static GamePlayRoomService CreateService(AppDbContext db, IHttpContextAccessor httpContextAccessor)
    {
        var currentProfile = new CurrentProfileService(db, httpContextAccessor);
        var currentAccess = new CurrentAccessService(currentProfile, new ConfigurationBuilder().Build(), httpContextAccessor, db, new EphemeralDataProtectionProvider(), NullLogger<CurrentAccessService>.Instance);
        return new GamePlayRoomService(
            db,
            new RoomCodeGenerator(),
            null!,
            null!,
            null!,
            currentAccess,
            currentProfile,
            new ProfileShareLinkService(db, new LocalProfileService(db, currentProfile), new MemoryCache(new MemoryCacheOptions())));
    }

    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var scope = await TestDbFixture.CreateScopeAsync();
        var db = scope.Db;
        var httpContext = new DefaultHttpContext();
        var accessor = new TestHttpContextAccessor(httpContext);
        return new TestFixture(scope, db, httpContext, accessor);
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed record TestFixture(TestDbFixture.Scope Scope, AppDbContext Db, DefaultHttpContext HttpContext, IHttpContextAccessor HttpContextAccessor) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Scope.DisposeAsync();
        }
    }
}
