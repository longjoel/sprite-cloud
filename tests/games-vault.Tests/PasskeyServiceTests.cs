using Fido2NetLib.Objects;
using games_vault.Data;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
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
        var scope = await TestDbFixture.CreateScopeAsync();
        var db = scope.Db;
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

        return new TestFixture(scope, db, httpContextAccessor, memoryCache, configuration);
    }

    private sealed record TestFixture(
        TestDbFixture.Scope Scope,
        AppDbContext Db,
        IHttpContextAccessor HttpContextAccessor,
        MemoryCache MemoryCache,
        IConfiguration Configuration) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            MemoryCache.Dispose();
            await Scope.DisposeAsync();
        }
    }
}
