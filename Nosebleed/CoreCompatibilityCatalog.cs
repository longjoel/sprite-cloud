namespace games_vault.Nosebleed;

public sealed record CoreCompatibilityEntry(
    string SystemName,
    string NativeCoreFileName,
    string? WebPlayerCoreKey = null,
    string Confidence = "exact");

public static class CoreCompatibilityCatalog
{
    public static IReadOnlyList<CoreCompatibilityEntry> Entries { get; } =
    [
        new("Nintendo - Nintendo Entertainment System", "fceumm_libretro.so", "fceumm"),
        new("Nintendo - Super Nintendo Entertainment System", "snes9x_libretro.so", "snes9x"),
        new("Nintendo - Game Boy", "gambatte_libretro.so", "gambatte"),
        new("Nintendo - Game Boy Color", "gambatte_libretro.so", "gambatte"),
        new("Nintendo - Game Boy Advance", "mgba_libretro.so", "mgba"),
        new("Sega - Game Gear", "genesis_plus_gx_libretro.so", "genesis_plus_gx"),
        new("Sega - Master System - Mark III", "genesis_plus_gx_libretro.so", "genesis_plus_gx"),
        new("Sega - Mega Drive - Genesis", "genesis_plus_gx_libretro.so", "genesis_plus_gx"),
        new("Sega - SG-1000", "genesis_plus_gx_libretro.so", "genesis_plus_gx"),
        new("NEC - PC Engine - TurboGrafx 16", "mednafen_pce_fast_libretro.so", "mednafen_pce_fast"),
        new("SNK - Neo Geo Pocket", "mednafen_ngp_libretro.so", "mednafen_ngp"),
        new("SNK - Neo Geo Pocket Color", "mednafen_ngp_libretro.so", "mednafen_ngp"),
        new("Atari - 2600", "stella_libretro.so", "stella"),
    ];

    public static CoreCompatibilityEntry? Find(string systemName) => Entries.FirstOrDefault(
        x => string.Equals(x.SystemName, systemName, StringComparison.OrdinalIgnoreCase));
}
