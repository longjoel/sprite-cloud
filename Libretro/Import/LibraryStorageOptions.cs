namespace games_vault.Libretro.Import;

public sealed class LibraryStorageOptions
{
    // Root directory for library content (ROMs/system files). Can be absolute or relative to ContentRootPath.
    public string RootPath { get; set; } = "App_Data/library";

    // Durable root directory for immutable per-profile battery save history. Can be absolute or relative to ContentRootPath.
    // When omitted, defaults under the main library root at "profile-saves".
    public string? ProfileSaveRootPath { get; set; }

    // Temporary staging directory for uploads, web-source downloads, and copy/import jobs.
    // Keep this outside /opt in production because systemd hardening makes the app content root read-only.
    public string UploadStagingRootPath { get; set; } = "App_Data/uploads";

    /// <summary>Watch folder auto-import configuration. Binds from Library:WatchFolder in config.</summary>
    public WatchFolderSettings? WatchFolder { get; set; }

    public sealed class WatchFolderSettings
    {
        /// <summary>Enable automatic ROM import from a watched folder.</summary>
        public bool Enabled { get; set; } = false;

        /// <summary>
        /// Absolute path to monitor for new/changed ROM files.
        /// When set, Games Vault watches this directory and auto-imports eligible files.
        /// Ideal for Docker volume mounts — drop ROMs in and they appear in the library.
        /// </summary>
        public string? Path { get; set; }

        /// <summary>
        /// Debounce interval in milliseconds. Coalesces rapid file events
        /// (e.g. bulk copy) into a single import pass. Default: 2000ms.
        /// </summary>
        public int DebounceMs { get; set; } = 2000;

        /// <summary>
        /// Import mode: Link leaves ROMs in place and records the external path;
        /// Copy moves them into the library's organized hierarchy.
        /// </summary>
        public WatchFolderImportMode Mode { get; set; } = WatchFolderImportMode.Link;
    }
}

public enum WatchFolderImportMode
{
    /// <summary>
    /// Leave files in place and record external paths. No file copy.
    /// Best for Docker volume mounts.
    /// </summary>
    Link,

    /// <summary>
    /// Copy files into Library/Roms/&lt;System&gt;/ organized hierarchy.
    /// </summary>
    Copy
}

