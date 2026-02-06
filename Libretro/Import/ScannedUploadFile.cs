namespace games_vault.Libretro.Import;

public sealed record ScannedUploadFile(
    string DisplayName,
    long SizeBytes,
    string Crc32);

