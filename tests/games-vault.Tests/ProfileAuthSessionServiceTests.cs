using games_vault.Data;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class ProfileAuthSessionServiceTests
{
    [Fact]
    public async Task CreateSessionAsync_EnforcesSingleActiveSessionPerProfileAtDatabaseLevel()
    {
        await using var fixture = await CreateFixtureAsync();
        var profile = new UserProfile
        {
            DisplayName = "Joel",
            Username = "joel",
            Color = "#198754",
            PasskeyUserHandleBase64Url = "handle",
            PasswordHash = "hash",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        fixture.Db.UserProfiles.Add(profile);
        await fixture.Db.SaveChangesAsync();

        var service = new ProfileAuthSessionService(fixture.Db, fixture.HttpContextAccessor);
        var first = await service.CreateSessionAsync(profile.Id, CancellationToken.None);

        await using var competingDb = new AppDbContext(fixture.Options);
        competingDb.ProfileAuthSessions.Add(new ProfileAuthSession
        {
            ProfileId = profile.Id,
            SessionNonce = "competing-session",
            LastSeenUtc = DateTime.UtcNow
        });

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => competingDb.SaveChangesAsync());

        var activeSessions = await fixture.Db.ProfileAuthSessions
            .AsNoTracking()
            .Where(x => x.ProfileId == profile.Id && x.RevokedUtc == null)
            .ToListAsync();
        Assert.Single(activeSessions);
        Assert.Equal(first.SessionNonce, activeSessions[0].SessionNonce);
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
        return new TestFixture(connection, options, db, httpContext, accessor);
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed record TestFixture(SqliteConnection Connection, DbContextOptions<AppDbContext> Options, AppDbContext Db, DefaultHttpContext HttpContext, IHttpContextAccessor HttpContextAccessor) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
