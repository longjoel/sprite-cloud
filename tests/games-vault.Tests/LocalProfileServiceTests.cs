using games_vault.Data;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class LocalProfileServiceTests
{
    [Fact]
    public async Task CreateAsync_CreatesFirstProfileAsAdminAndSelectsIt()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));

        var profile = await service.CreateAsync("  Joel  ", "Joel.Admin", "password123", "not-a-color", CancellationToken.None);

        Assert.Equal("Joel", profile.DisplayName);
        Assert.Equal("joel.admin", profile.Username);
        Assert.Equal("#0d6efd", profile.Color);
        Assert.True(profile.IsAdmin);
        Assert.False(string.IsNullOrWhiteSpace(profile.PasskeyUserHandleBase64Url));
        Assert.False(string.IsNullOrWhiteSpace(profile.PasswordHash));
        Assert.Single(await fixture.Db.UserProfiles.ToListAsync());
        Assert.Contains($"{CurrentProfileService.CookieName}={profile.Id}", fixture.HttpContext.Response.Headers.SetCookie.ToString());
    }

    [Fact]
    public async Task CreateAsync_CreatesLaterProfilesAsPlayers()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));

        await service.CreateAsync("First", "first", "password123", "#198754", CancellationToken.None);
        var second = await service.CreateAsync("Second", "second", "password456", "#dc3545", CancellationToken.None);

        Assert.False(second.IsAdmin);
        Assert.Equal("second", second.Username);
        Assert.Equal("#dc3545", second.Color);
        Assert.Equal(2, await fixture.Db.UserProfiles.CountAsync());
    }

    [Fact]
    public async Task SignInAsync_CreatesProfileSessionCookieAndAuthSessionRecord()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var service = new LocalProfileService(fixture.Db, current);
        var profile = await service.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);

        fixture.HttpContext.Response.Headers.Clear();

        var signedIn = await service.SignInAsync("JOEL", "password123", CancellationToken.None);

        Assert.True(signedIn);
        Assert.Contains($"{CurrentProfileService.CookieName}={profile.Id}", fixture.HttpContext.Response.Headers.SetCookie.ToString());
        Assert.Contains(CurrentProfileService.SessionCookieName, fixture.HttpContext.Response.Headers.SetCookie.ToString());

        var authSession = await fixture.Db.ProfileAuthSessions.SingleAsync(x => x.ProfileId == profile.Id && x.RevokedUtc == null);
        Assert.Equal(profile.Id, authSession.ProfileId);
        Assert.Null(authSession.RevokedUtc);
        Assert.False(string.IsNullOrWhiteSpace(authSession.SessionNonce));
    }

    [Fact]
    public async Task SignInAsync_RevokesPreviousSessionWhenSameProfileSignsInAgain()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var service = new LocalProfileService(fixture.Db, current);
        var profile = await service.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);

        fixture.HttpContext.Response.Headers.Clear();
        Assert.True(await service.SignInAsync("joel", "password123", CancellationToken.None));
        var firstSession = await fixture.Db.ProfileAuthSessions.SingleAsync(x => x.ProfileId == profile.Id && x.RevokedUtc == null);

        fixture.HttpContext.Response.Headers.Clear();
        Assert.True(await service.SignInAsync("joel", "password123", CancellationToken.None));

        var sessions = await fixture.Db.ProfileAuthSessions
            .Where(x => x.ProfileId == profile.Id)
            .OrderBy(x => x.Id)
            .ToListAsync();
        Assert.Equal(3, sessions.Count);
        Assert.Equal(firstSession.Id, sessions[1].Id);
        Assert.NotNull(sessions[1].RevokedUtc);
        Assert.Null(sessions[2].RevokedUtc);
        Assert.NotEqual(sessions[1].SessionNonce, sessions[2].SessionNonce);
    }

    [Fact]
    public async Task ChangePasswordAsync_UpdatesStoredPasswordAndRequiresNewPasswordForFutureSignIn()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var service = new LocalProfileService(fixture.Db, current);
        var profile = await service.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);

        var changed = await service.ChangePasswordAsync(profile.Id, "password123", "better-password", CancellationToken.None);

        Assert.True(changed);
        Assert.False(await service.SignInAsync("joel", "password123", CancellationToken.None));
        Assert.True(await service.SignInAsync("joel", "better-password", CancellationToken.None));
    }

    [Fact]
    public async Task ChangePasswordAsync_ReturnsFalseWhenCurrentPasswordDoesNotMatch()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var service = new LocalProfileService(fixture.Db, current);
        await service.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);

        var changed = await service.ChangePasswordAsync(1, "wrong-password", "better-password", CancellationToken.None);

        Assert.False(changed);
        Assert.True(await service.SignInAsync("joel", "password123", CancellationToken.None));
        Assert.False(await service.SignInAsync("joel", "better-password", CancellationToken.None));
    }

    [Fact]
    public async Task CreateAsync_RejectsDuplicateUsername()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));

        await service.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.CreateAsync("Another Joel", "JOEL", "password456", "#dc3545", CancellationToken.None));
    }

    [Fact]
    public async Task SignInAsync_AllowsLegacyFourDigitPasswordHashUntilUserChangesIt()
    {
        await using var fixture = await CreateFixtureAsync();
        var current = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var service = new LocalProfileService(fixture.Db, current);
        fixture.Db.UserProfiles.Add(new games_vault.Models.UserProfile
        {
            DisplayName = "Legacy",
            Username = "legacy",
            Color = "#198754",
            PasskeyUserHandleBase64Url = "legacy-handle",
            PasswordHash = "pbkdf2-sha256$100000$Z2FtZXMtdmF1bHQtMDAwMA==$kUOw3H8stAGil7YWc+tGX31NGrlrWYgJnS5C+mNOhDI=",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        });
        await fixture.Db.SaveChangesAsync();

        Assert.True(await service.SignInAsync("legacy", "0000", CancellationToken.None));
        Assert.True(await service.ChangePasswordAsync(1, "0000", "better-password", CancellationToken.None));
        Assert.False(await service.SignInAsync("legacy", "0000", CancellationToken.None));
        Assert.True(await service.SignInAsync("legacy", "better-password", CancellationToken.None));
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
