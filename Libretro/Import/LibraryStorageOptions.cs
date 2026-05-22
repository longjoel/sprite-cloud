namespace games_vault.Libretro.Import;

public sealed class LibraryStorageOptions
{
    // Root directory for library content (ROMs/system files). Can be absolute or relative to ContentRootPath.
    public string RootPath { get; set; } = "App_Data/library";

    // Temporary staging directory for uploads, web-source downloads, and copy/import jobs.
    // Keep this outside /opt in production because systemd hardening makes the app content root read-only.
    public string UploadStagingRootPath { get; set; } = "App_Data/uploads";
}

