namespace games_vault.Libretro.Dat;

public sealed class LibretroDatIndex(IReadOnlyDictionary<string, LibretroDatRomEntry> byCrc32)
{
    public IReadOnlyDictionary<string, LibretroDatRomEntry> ByCrc32 { get; } = byCrc32;

    public bool TryGetByCrc32(string crc32, out LibretroDatRomEntry entry) =>
        ByCrc32.TryGetValue(NormalizeCrc32(crc32), out entry!);

    public static string NormalizeCrc32(string crc32) =>
        (crc32 ?? "").Trim().ToUpperInvariant();
}

