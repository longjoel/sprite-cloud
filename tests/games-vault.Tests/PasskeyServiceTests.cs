using Fido2NetLib.Objects;
using games_vault.Data;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

namespace games_vault.Tests;

public sealed class PasskeyServiceTests
{
    [Fact]
    public async Task BeginRegistration_RequiresResidentKey()
    {
        await using var fixture = await CreateFixtureAsync();
        var service = new PasskeyService(
            fixture.Db,
            fixture.MemoryCache,
            fixture.HttpContextAccessor,
            new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor),
            new ProfileAuthSessionService(fixture.Db, fixture.HttpContextAccessor),
            fixture.Configuration);

        var options = service.BeginRegistration("Joel", "#198754", "Steam Deck");

        Assert.NotNull(options.AuthenticatorSelection);
        Assert.Equal(ResidentKeyRequirement.Required, options.AuthenticatorSelection.ResidentKey);
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
        var httpContextAccessor = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        var memoryCache = new MemoryCache(new MemoryCacheOptions());
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Passkeys:RelyingPartyId"] = "localhost",
                ["Passkeys:RelyingPartyName"] = "Games Vault",
                ["Passkeys:Origins:0"] = "https://localhost"
            })
            .Build();

        return new TestFixture(connection, db, httpContextAccessor, memoryCache, configuration);
    }

    private sealed record TestFixture(
        SqliteConnection Connection,
        AppDbContext Db,
        IHttpContextAccessor HttpContextAccessor,
        MemoryCache MemoryCache,
        IConfiguration Configuration) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            MemoryCache.Dispose();
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
