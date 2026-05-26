using games_vault.Data;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class SystemCoreMappingResolverTests
{
    [Fact]
    public async Task ResolveNativeCoreAsync_prefers_database_mapping_over_appsettings_fallback()
    {
        await using var fixture = await CreateFixtureAsync();
        fixture.Db.SystemCoreMappings.Add(new SystemCoreMapping
        {
            SystemName = "Sega - Mega Drive - Genesis",
            NativeCoreFileName = "genesis_plus_gx_libretro.so",
            WebPlayerCoreKey = "genesis_plus_gx",
            IsEnabled = true
        });
        await fixture.Db.SaveChangesAsync();

        var resolver = new SystemCoreMappingResolver(
            fixture.Db,
            Options.Create(new NosebleedOptions
            {
                SystemCores = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Sega - Mega Drive - Genesis"] = "wrong_libretro.so"
                }
            }));

        var resolved = await resolver.ResolveNativeCoreAsync("Sega - Mega Drive - Genesis");

        Assert.Equal("genesis_plus_gx_libretro.so", resolved);
    }

    [Fact]
    public async Task ResolveNativeCoreAsync_uses_appsettings_fallback_when_database_mapping_is_missing()
    {
        await using var fixture = await CreateFixtureAsync();
        var resolver = new SystemCoreMappingResolver(
            fixture.Db,
            Options.Create(new NosebleedOptions
            {
                SystemCores = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Nintendo - Nintendo Entertainment System"] = "fceumm_libretro.so"
                }
            }));

        var resolved = await resolver.ResolveNativeCoreAsync("Nintendo - Nintendo Entertainment System");

        Assert.Equal("fceumm_libretro.so", resolved);
    }

    [Fact]
    public async Task GetDetectedSystemsAsync_marks_systems_without_mappings_as_missing()
    {
        await using var fixture = await CreateFixtureAsync();
        fixture.Db.Games.AddRange(
            new Game { Name = "Sonic", SystemName = "Sega - Mega Drive - Genesis", SizeBytes = 1 },
            new Game { Name = "Castle of Illusion", SystemName = "Sega - Game Gear", SizeBytes = 1 });
        fixture.Db.SystemCoreMappings.Add(new SystemCoreMapping
        {
            SystemName = "Sega - Game Gear",
            NativeCoreFileName = "genesis_plus_gx_libretro.so",
            IsEnabled = true
        });
        await fixture.Db.SaveChangesAsync();

        var resolver = new SystemCoreMappingResolver(
            fixture.Db,
            Options.Create(new NosebleedOptions()));

        var systems = await resolver.GetDetectedSystemsAsync();

        var genesis = Assert.Single(systems, x => x.SystemName == "Sega - Mega Drive - Genesis");
        Assert.Null(genesis.NativeCoreFileName);
        Assert.False(genesis.HasNativeCoreMapping);

        var gameGear = Assert.Single(systems, x => x.SystemName == "Sega - Game Gear");
        Assert.Equal("genesis_plus_gx_libretro.so", gameGear.NativeCoreFileName);
        Assert.True(gameGear.HasNativeCoreMapping);
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
        return new TestFixture(connection, db);
    }

    private sealed record TestFixture(SqliteConnection Connection, AppDbContext Db) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
