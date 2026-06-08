using games_vault.Data;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

/// <summary>
/// Shared base class for test fixtures that provides an in-memory SQLite database context.
/// Subclasses get a ready-to-use AppDbContext and can override SeedDataAsync() for test data.
/// </summary>
public class GamesVaultTestBase : IAsyncDisposable
{
    protected SqliteConnection _connection;
    protected AppDbContext Db { get; }

    public GamesVaultTestBase()
    {
        _connection = new SqliteConnection("Data Source=:memory:");
        _connection.Open();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;

        Db = new AppDbContext(options);
        Db.Database.EnsureCreated();
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
        await Db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }
}
