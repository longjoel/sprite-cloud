namespace games_vault.NetworkShares;

public sealed record SmbFileEntry(
    string SmbUri,
    string FileName,
    long SizeBytes,
    DateTime? LastWriteUtc);

