namespace games_vault.Libretro;

public sealed class LibretroDatabaseOptions
{
    public string RootPath { get; set; } = "App_Data/libretro-database";

    public string ZipUrl { get; set; } =
        "https://github.com/libretro/libretro-database/archive/refs/heads/master.zip";
}
