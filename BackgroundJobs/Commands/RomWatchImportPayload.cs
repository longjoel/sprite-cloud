namespace games_vault.BackgroundJobs.Commands;

/// <summary>
/// Payload for the rom.watch command. Contains file paths discovered
/// by the RomFolderWatcher that need to be imported into the library.
/// </summary>
public sealed record RomWatchImportPayload(string[] Paths, int TotalEnqueued);
