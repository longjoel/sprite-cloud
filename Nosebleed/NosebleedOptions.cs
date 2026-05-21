namespace games_vault.Nosebleed;

public sealed class NosebleedOptions
{
    public bool Enabled { get; set; } = false;

    public string BinaryPath { get; set; } = "/opt/nosebleed/nosebleed";

    public string PublicScheme { get; set; } = "http";

    public string PublicHost { get; set; } = "localhost";

    public int BaseListenPort { get; set; } = 8100;

    public int MaxSessions { get; set; } = 4;

    public string SessionRoot { get; set; } = "/srv/storage/games-vault/nosebleed/sessions";

    public string CoreRoot { get; set; } = "/srv/storage/games-vault/nosebleed/cores";

    public bool RequireAuth { get; set; } = true;

    public string AuthSecretPath { get; set; } = "/var/lib/games-vault/nosebleed-auth-secret";

    public int TicketTtlMinutes { get; set; } = 120;

    public int MaxPlayersPerSession { get; set; } = 4;

    public int SeatTtlMinutes { get; set; } = 30;

    public bool CopyContentToSession { get; set; } = true;

    public float Fps { get; set; } = 60;

    public Dictionary<string, string> SystemCores { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}
