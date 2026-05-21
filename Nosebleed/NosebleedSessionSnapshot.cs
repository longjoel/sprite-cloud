namespace games_vault.Nosebleed;

public sealed record NosebleedSessionSnapshot(
    string SessionId,
    int GameId,
    int FileId,
    int Port,
    string BaseUrl,
    DateTimeOffset StartedUtc,
    string CorePath,
    string ContentPath,
    int ProcessId,
    bool HasExited,
    TimeSpan Runtime);
