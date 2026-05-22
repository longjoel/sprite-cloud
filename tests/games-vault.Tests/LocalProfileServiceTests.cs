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

        var profile = await service.CreateAsync("  Joel  ", "not-a-color", CancellationToken.None);

        Assert.Equal("Joel", profile.DisplayName);
        Assert.Equal("#0d6efd", profile.Color);
        Assert.True(profile.IsAdmin);
        Assert.False(string.IsNullOrWhiteSpace(profile.PasskeyUserHandleBase64Url));
        Assert.Single(await fixture.Db.UserProfiles.ToListAsync());
        Assert.Contains($"{CurrentProfileService.CookieName}={profile.Id}", fixture.HttpContext.Response.Headers.SetCookie.ToString());
    }

    [Fact]
    public async Task CreateAsync_CreatesLaterProfilesAsPlayers()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));

        await service.CreateAsync("First", "#198754", CancellationToken.None);
        var second = await service.CreateAsync("Second", "#dc3545", CancellationToken.None);

        Assert.False(second.IsAdmin);
        Assert.Equal("#dc3545", second.Color);
        Assert.Equal(2, await fixture.Db.UserProfiles.CountAsync());
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
