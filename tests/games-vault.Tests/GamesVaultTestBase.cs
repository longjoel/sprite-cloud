using games_vault.Data;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.DataProtection;

namespace games_vault.Tests;

/// <summary>
/// Shared base class for test fixtures that provides an in-memory SQLite database context.
/// Subclasses get a ready-to-use AppDbContext and can override SeedDataAsync() for test data.
/// </summary>
public class GamesVaultTestBase : IAsyncDisposable
{
    private readonly TestDbFixture.Scope _scope;
    protected AppDbContext Db { get; }

    public GamesVaultTestBase()
    {
        _scope = TestDbFixture.CreateScopeAsync().GetAwaiter().GetResult();
        Db = _scope.Db;
    }

    /// <summary>
    /// Override to seed test data after the database is created.
    /// Called automatically after EnsureCreated in the constructor.
    /// </summary>
    public virtual Task SeedDataAsync() => Task.CompletedTask;

    /// <summary>
    /// Creates an IHttpContextAccessor wrapping a new DefaultHttpContext.
    /// </summary>
    protected static IHttpContextAccessor CreateHttpContextAccessor()
    {
        return new TestHttpContextAccessor(new DefaultHttpContext());
    }

    /// <summary>
    /// Creates an IHttpContextAccessor wrapping the given DefaultHttpContext.
    /// </summary>
    protected static IHttpContextAccessor CreateHttpContextAccessor(DefaultHttpContext httpContext)
    {
        return new TestHttpContextAccessor(httpContext);
    }

    public async ValueTask DisposeAsync()
    {
        await _scope.DisposeAsync();
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    protected static CurrentProfileService CreateCurrentProfileService(AppDbContext db, IHttpContextAccessor http)
    {
        var provider = DataProtectionProvider.Create("GamesVault.Tests");
        return new CurrentProfileService(db, http, provider);
    }
}
