namespace games_vault.Web;

public sealed class WebPlayerOptions
{
    public bool Enabled { get; set; } = false;

    // Base path under wwwroot where the player assets live, e.g. "/webplayer".
    public string BasePath { get; set; } = "/webplayer";

    // If true and player assets are missing at startup, queue an install job using RetroArchZipUrl.
    public bool AutoInstall { get; set; } = true;

    // Zip URL for a RetroArch (Emscripten) web build to install when assets are missing.
    public string? RetroArchZipUrl { get; set; }

    // Map libretro system names (Game.SystemName) to a core identifier understood by the player.
    public Dictionary<string, string> SystemCores { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}
