using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class ProfileShareLinkServiceTests : GamesVaultTestBase
{
    [Fact]
    public async Task CreateAsync_CreatesSingleUseShareLinkForRoomWithoutPersistingRawToken()
    {
        var httpContextAccessor = CreateHttpContextAccessor();
        var httpContext = (DefaultHttpContext)httpContextAccessor.HttpContext!;
        var localProfiles = new LocalProfileService(Db, new CurrentProfileService(Db, httpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        var room = await CreateRoomAsync(host.Id);
        var service = CreateShareLinkService(httpContextAccessor);

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
        var httpContextAccessor = CreateHttpContextAccessor();
        var httpContext = (DefaultHttpContext)httpContextAccessor.HttpContext!;
        var localProfiles = new LocalProfileService(Db, new CurrentProfileService(Db, httpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        var room = await CreateRoomAsync(host.Id);
        var service = CreateShareLinkService(httpContextAccessor);
        var created = await service.CreateAsync(room.Id, host.Id, RoomShareGrantMode.Spectator, CancellationToken.None);

        httpContext.Response.Headers.Clear();

        var redeemed = await service.RedeemAsync(created.RawToken, CancellationToken.None);

        Assert.Equal(RoomShareGrantMode.Spectator, redeemed.ShareLink.GrantMode);
        Assert.NotNull(redeemed.Profile);
        Assert.True(redeemed.Profile!.IsEphemeral);
        Assert.Equal(host.Id, redeemed.Profile.ParentProfileId);
        Assert.Equal(redeemed.Profile.Id, redeemed.ShareLink.RedeemedByProfileId);
        Assert.Equal(1, redeemed.ShareLink.UseCount);
        Assert.NotNull(redeemed.ShareLink.LastUsedUtc);
        Assert.Contains($"{CurrentProfileService.CookieName}={redeemed.Profile.Id}", httpContext.Response.Headers.SetCookie.ToString());

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.RedeemAsync(created.RawToken, CancellationToken.None));
    }

    private ProfileShareLinkService CreateShareLinkService(IHttpContextAccessor httpContextAccessor)
    {
        var currentProfile = new CurrentProfileService(Db, httpContextAccessor);
        var localProfiles = new LocalProfileService(Db, currentProfile);
        return new ProfileShareLinkService(Db, localProfiles);
    }

    private async Task<GamePlayRoom> CreateRoomAsync(int createdByProfileId)
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
}
