namespace games_vault.Libretro.Dat;

public sealed record LibretroDatRomEntry(
    string SystemName,
    string GameName,
    string RomName,
    string Crc32,
    long? DeclaredSizeBytes);

