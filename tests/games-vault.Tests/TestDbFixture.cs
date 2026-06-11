using games_vault.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Testcontainers.PostgreSql;

namespace games_vault.Tests;

public static class TestDbFixture
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static PostgreSqlContainer? _container;
    private static Task? _startTask;

    public sealed record Scope(string AdminConnectionString, string DatabaseName, DbContextOptions<AppDbContext> Options, AppDbContext Db) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();

            await using var connection = new NpgsqlConnection(AdminConnectionString);
            await connection.OpenAsync();

            await using (var terminate = connection.CreateCommand())
            {
                terminate.CommandText = @"
                    SELECT pg_terminate_backend(pid)
                    FROM pg_stat_activity
                    WHERE datname = @databaseName AND pid <> pg_backend_pid();";
                terminate.Parameters.AddWithValue("databaseName", DatabaseName);
                await terminate.ExecuteNonQueryAsync();
            }

            await using (var drop = connection.CreateCommand())
            {
                drop.CommandText = $"DROP DATABASE IF EXISTS \"{DatabaseName}\"";
                await drop.ExecuteNonQueryAsync();
            }
        }
    }

    public static async Task<Scope> CreateScopeAsync()
    {
        var adminConnectionString = await GetAdminConnectionStringAsync();
        var databaseName = $"test_{Guid.NewGuid():N}";

        await using (var connection = new NpgsqlConnection(adminConnectionString))
        {
            await connection.OpenAsync();
            await using var create = connection.CreateCommand();
            create.CommandText = $"CREATE DATABASE \"{databaseName}\"";
            await create.ExecuteNonQueryAsync();
        }

        var testConnectionString = new NpgsqlConnectionStringBuilder(adminConnectionString)
        {
            Database = databaseName
        }.ConnectionString;

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(testConnectionString)
            .Options;

        var db = new AppDbContext(options);
        await db.Database.EnsureCreatedAsync();

        return new Scope(adminConnectionString, databaseName, options, db);
    }

    private static async Task<string> GetAdminConnectionStringAsync()
    {
        await Gate.WaitAsync();
        try
        {
            if (_container is null)
            {
                _container = new PostgreSqlBuilder("postgres:16-alpine")
                    .WithDatabase("gamesvault_admin")
                    .WithUsername("test")
                    .WithPassword("test")
                    .Build();
            }

            _startTask ??= _container.StartAsync();
        }
        finally
        {
            Gate.Release();
        }

        await _startTask!;
        return _container!.GetConnectionString();
    }
}
