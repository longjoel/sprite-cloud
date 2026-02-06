namespace games_vault.Libretro.Import;

public sealed class LibraryStorageOptions
{
    // Root directory for library content (ROMs/system files). Can be absolute or relative to ContentRootPath.
    public string RootPath { get; set; } = "App_Data/library";
}

