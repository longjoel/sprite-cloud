using games_vault.Data;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class SystemCoreAutomapperTests
{
    [Fact]
    public async Task AutoMapDetectedSystemsAsync_creates_mapping_when_known_core_is_installed()
    {
        await using var fixture = await CreateFixtureAsync();
        fixture.Db.Games.Add(new Game { Name = "Sonic", SystemName = "Sega - Mega Drive - Genesis", SizeBytes = 1 });
        await fixture.Db.SaveChangesAsync();

        var automapper = new SystemCoreAutomapper(fixture.Db);

        var result = await automapper.AutoMapDetectedSystemsAsync(["genesis_plus_gx_libretro.so"]);

        Assert.Equal(1, result.Created);
        var mapping = await fixture.Db.SystemCoreMappings.SingleAsync(x => x.SystemName == "Sega - Mega Drive - Genesis");
        Assert.Equal("genesis_plus_gx_libretro.so", mapping.NativeCoreFileName);
        Assert.Equal("genesis_plus_gx", mapping.WebPlayerCoreKey);
        Assert.True(mapping.IsAutoMapped);
    }

    [Fact]
    public async Task AutoMapDetectedSystemsAsync_does_not_overwrite_manual_mapping()
    {
        await using var fixture = await CreateFixtureAsync();
        fixture.Db.Games.Add(new Game { Name = "Sonic", SystemName = "Sega - Mega Drive - Genesis", SizeBytes = 1 });
        fixture.Db.SystemCoreMappings.Add(new SystemCoreMapping
        {
            SystemName = "Sega - Mega Drive - Genesis",
            NativeCoreFileName = "manual_libretro.so",
            WebPlayerCoreKey = "manual",
            IsEnabled = true,
            IsAutoMapped = false
        });
        await fixture.Db.SaveChangesAsync();

        var automapper = new SystemCoreAutomapper(fixture.Db);

        var result = await automapper.AutoMapDetectedSystemsAsync(["genesis_plus_gx_libretro.so"]);

        Assert.Equal(0, result.Created);
        Assert.Equal(0, result.Updated);
        var mapping = await fixture.Db.SystemCoreMappings.SingleAsync(x => x.SystemName == "Sega - Mega Drive - Genesis");
        Assert.Equal("manual_libretro.so", mapping.NativeCoreFileName);
        Assert.Equal("manual", mapping.WebPlayerCoreKey);
        Assert.False(mapping.IsAutoMapped);
    }

    [Fact]
    public async Task AutoMapDetectedSystemsAsync_reports_missing_core_without_creating_mapping()
    {
        await using var fixture = await CreateFixtureAsync();
        fixture.Db.Games.Add(new Game { Name = "Metroid", SystemName = "Nintendo - Game Boy Advance", SizeBytes = 1 });
        await fixture.Db.SaveChangesAsync();

        var automapper = new SystemCoreAutomapper(fixture.Db);

        var result = await automapper.AutoMapDetectedSystemsAsync(["genesis_plus_gx_libretro.so"]);

        Assert.Equal(0, result.Created);
        Assert.Equal(1, result.MissingCore);
        Assert.Empty(await fixture.Db.SystemCoreMappings.ToListAsync());
    }

    [Fact]
    public async Task AutoMapDetectedSystemsAsync_creates_mame_mapping_when_mame_core_is_installed()
    {
        await using var fixture = await CreateFixtureAsync();
        fixture.Db.Games.Add(new Game { Name = "Joust", SystemName = "MAME", SizeBytes = 1 });
        await fixture.Db.SaveChangesAsync();

        var automapper = new SystemCoreAutomapper(fixture.Db);

        var result = await automapper.AutoMapDetectedSystemsAsync(["mame2003_plus_libretro.so"]);

        Assert.Equal(1, result.Created);
        var mapping = await fixture.Db.SystemCoreMappings.SingleAsync(x => x.SystemName == "MAME");
        Assert.Equal("mame2003_plus_libretro.so", mapping.NativeCoreFileName);
        Assert.Null(mapping.WebPlayerCoreKey);
        Assert.True(mapping.IsAutoMapped);
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
