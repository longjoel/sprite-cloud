namespace games_vault.Nosebleed;

public sealed record NosebleedSession(
    string Id,
    int GameId,
    int FileId,
    int Port,
    string BaseUrl,
    string LocalUrl,
    string? Token,
    DateTimeOffset StartedUtc,
    string CorePath,
    string ContentPath);

public sealed record NosebleedStartResult(NosebleedSession? Session, string? Error)
{
    public bool Success => Session is not null && string.IsNullOrWhiteSpace(Error);

    public static NosebleedStartResult Ok(NosebleedSession session) => new(session, null);

    public static NosebleedStartResult Fail(string error) => new(null, error);
}
