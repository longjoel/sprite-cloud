using games_vault.Nosebleed;

namespace games_vault.Tests;

public sealed class LibretroCoreInstallerTests
{
    [Fact]
    public void BuildCoreZipUri_uses_configured_buildbot_base_url()
    {
        var uri = LibretroCoreInstaller.BuildCoreZipUri(
            "https://buildbot.libretro.com/nightly/linux/x86_64/latest/",
            "snes9x_libretro.so");

        Assert.Equal("https://buildbot.libretro.com/nightly/linux/x86_64/latest/snes9x_libretro.so.zip", uri.ToString());
    }

    [Fact]
    public void Catalog_knows_snes_native_and_web_cores()
    {
        var entry = CoreCompatibilityCatalog.Find("Nintendo - Super Nintendo Entertainment System");

        Assert.NotNull(entry);
        Assert.Equal("snes9x_libretro.so", entry.NativeCoreFileName);
        Assert.Equal("snes9x", entry.WebPlayerCoreKey);
    }
}
