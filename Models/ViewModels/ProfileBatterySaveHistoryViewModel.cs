namespace games_vault.Models.ViewModels;

public sealed class ProfileBatterySaveHistoryViewModel
{
    public required int GameId { get; init; }
    public required int GameFileId { get; init; }
    public required string GameName { get; init; }
    public required string GameFileName { get; init; }
    public required string SystemName { get; init; }
    public IReadOnlyList<ProfileBatterySaveHistoryRow> Revisions { get; init; } = [];
    public IReadOnlyList<ProfileBatterySaveLogEntry> Diagnostics { get; init; } = [];
}

public sealed record ProfileBatterySaveLogEntry(string Level, string Title, string Message);

public sealed class ProfileBatterySaveHistoryRow
{
    public required int RevisionId { get; init; }
    public required int ProfileGameSaveId { get; init; }
    public required string Key { get; init; }
    public required string FileName { get; init; }
    public string? CoreKey { get; init; }
    public required string Kind { get; init; }
    public required DateTime RevisionTimestampUtc { get; init; }
    public required string StoragePath { get; init; }
    public required long SizeBytes { get; init; }
    public required string Sha256 { get; init; }
    public required string Source { get; init; }
    public string? OriginalUploadFileName { get; init; }
    public int? GamePlaySessionId { get; init; }
    public required bool IsLatest { get; init; }
}