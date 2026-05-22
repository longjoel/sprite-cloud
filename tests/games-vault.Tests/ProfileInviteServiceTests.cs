using games_vault.Data;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
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
    public async Task CreateWithInviteAsync_ConsumesInviteAndDefaultsPinTo0000()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var inviteService = new ProfileInviteService(fixture.Db);
        var profileService = new LocalProfileService(fixture.Db, current, inviteService);
        var invite = await inviteService.GenerateAsync(CancellationToken.None);

        var profile = await profileService.CreateWithInviteAsync("  Joel  ", "not-a-color", invite.Code, CancellationToken.None);

        Assert.Equal("Joel", profile.DisplayName);
        Assert.Equal("#0d6efd", profile.Color);
        Assert.True(profile.IsAdmin);
        Assert.True(await profileService.VerifyPinAsync(profile.Id, "0000", CancellationToken.None));
        Assert.False(await profileService.VerifyPinAsync(profile.Id, "1234", CancellationToken.None));
        Assert.True((await fixture.Db.ProfileInviteCodes.SingleAsync()).IsUsed);
        Assert.Equal(profile.Id, (await fixture.Db.ProfileInviteCodes.SingleAsync()).UsedByProfileId);
        Assert.Contains($"{CurrentProfileService.CookieName}={profile.Id}", fixture.HttpContext.Response.Headers.SetCookie.ToString());
    }

    [Fact]
    public async Task CreateWithInviteAsync_RejectsMissingOrUsedInviteCode()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var inviteService = new ProfileInviteService(fixture.Db);
        var profileService = new LocalProfileService(fixture.Db, current, inviteService);
        var invite = await inviteService.GenerateAsync(CancellationToken.None);
        await profileService.CreateWithInviteAsync("First", "#198754", invite.Code, CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(() => profileService.CreateWithInviteAsync("Second", "#dc3545", invite.Code, CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => profileService.CreateWithInviteAsync("Third", "#dc3545", "missing", CancellationToken.None));
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
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
