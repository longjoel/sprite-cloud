using games_vault.Data;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class ProfileInviteServiceTests
{
    [Fact]
    public async Task GenerateAsync_CreatesUnusedInviteCodeWithShareableToken()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new ProfileInviteService(fixture.Db);

        var invite = await service.GenerateAsync(CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(invite.Code));
        Assert.False(invite.IsUsed);
        Assert.Single(await fixture.Db.ProfileInviteCodes.ToListAsync());
    }

    [Fact]
    public async Task CreateWithInviteAsync_ConsumesInviteAndStoresUsernameAndPassword()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var inviteService = new ProfileInviteService(fixture.Db);
        var profileService = new LocalProfileService(fixture.Db, current, inviteService);
        var invite = await inviteService.GenerateAsync(CancellationToken.None);

        var profile = await profileService.CreateWithInviteAsync("  Joel  ", "Joel.Player", "password123", "not-a-color", invite.Code, CancellationToken.None);

        Assert.Equal("Joel", profile.DisplayName);
        Assert.Equal("joel.player", profile.Username);
        Assert.Equal("#0d6efd", profile.Color);
        Assert.True(profile.IsAdmin);
        Assert.True(await profileService.VerifyPasswordAsync(profile.Id, "password123", CancellationToken.None));
        Assert.False(await profileService.VerifyPasswordAsync(profile.Id, "wrong-password", CancellationToken.None));
        Assert.True((await fixture.Db.ProfileInviteCodes.SingleAsync()).IsUsed);
        Assert.Equal(profile.Id, (await fixture.Db.ProfileInviteCodes.SingleAsync()).UsedByProfileId);
        Assert.Contains(CurrentProfileService.CookieName, fixture.HttpContext.Response.Headers.SetCookie.ToString());
    }

    [Fact]
    public async Task CreateWithInviteAsync_RejectsMissingOrUsedInviteCode()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var inviteService = new ProfileInviteService(fixture.Db);
        var profileService = new LocalProfileService(fixture.Db, current, inviteService);
        var invite = await inviteService.GenerateAsync(CancellationToken.None);
        await profileService.CreateWithInviteAsync("First", "first", "password123", "#198754", invite.Code, CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(() => profileService.CreateWithInviteAsync("Second", "second", "password456", "#dc3545", invite.Code, CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => profileService.CreateWithInviteAsync("Third", "third", "password789", "#dc3545", "missing", CancellationToken.None));
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
