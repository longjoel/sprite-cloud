using games_vault.Models;
using games_vault.Nosebleed;

namespace games_vault.Tests;

public sealed class InstalledCoreInventoryBuilderTests
{
    [Fact]
    public void Build_marks_known_and_unknown_installed_cores_and_sorts_systems()
    {
        var builder = new InstalledCoreInventoryBuilder();
        var mappings = new[]
        {
            new SystemCoreMapping
            {
                SystemName = "Arcade Custom",
                NativeCoreFileName = "fbneo_libretro.so",
                IsEnabled = true
            },
            new SystemCoreMapping
            {
                SystemName = "Sega - Mega Drive - Genesis",
                NativeCoreFileName = "genesis_plus_gx_libretro.so",
                IsEnabled = true
            },
            new SystemCoreMapping
            {
                SystemName = "Sega - Game Gear",
                NativeCoreFileName = "genesis_plus_gx_libretro.so",
                IsEnabled = true
            }
        };

        var rows = builder.Build(
            ["fbneo_libretro.so", "genesis_plus_gx_libretro.so", "custom_test_libretro.so"],
            mappings);

        var custom = Assert.Single(rows, x => x.FileName == "custom_test_libretro.so");
        Assert.False(custom.IsKnownToCatalog);
        Assert.Equal("Custom Test", custom.DisplayName);
        Assert.Empty(custom.KnownSystemNames);
        Assert.Empty(custom.UsedBySystemNames);

        var fbneo = Assert.Single(rows, x => x.FileName == "fbneo_libretro.so");
        Assert.False(fbneo.IsKnownToCatalog);
        Assert.Equal(["Arcade Custom"], fbneo.UsedBySystemNames);

        var genesis = Assert.Single(rows, x => x.FileName == "genesis_plus_gx_libretro.so");
        Assert.True(genesis.IsKnownToCatalog);
        Assert.Equal(
            [
                "Sega - Game Gear",
                "Sega - Master System - Mark III",
                "Sega - Mega Drive - Genesis",
                "Sega - SG-1000"
            ],
            genesis.KnownSystemNames);
        Assert.Equal(
            [
                "Sega - Game Gear",
                "Sega - Mega Drive - Genesis"
            ],
            genesis.UsedBySystemNames);
    }

    [Theory]
    [InlineData("fbneo_libretro.so", "Fbneo")]
    [InlineData("mame2003_plus_libretro.so", "Mame2003 Plus")]
    [InlineData("genesis_plus_gx_libretro.so", "Genesis Plus Gx")]
    public void ToDisplayName_humanizes_native_core_file_names(string fileName, string expected)
    {
        Assert.Equal(expected, InstalledCoreInventoryBuilder.ToDisplayName(fileName));
    }
}
