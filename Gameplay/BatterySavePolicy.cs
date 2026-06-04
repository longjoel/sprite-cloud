namespace games_vault.Gameplay;

public enum BatterySavePersistenceMode
{
    None = 0,
    PerProfile = 1
}

public readonly record struct BatterySavePolicy(BatterySavePersistenceMode Mode, int? ProfileId)
{
    public static BatterySavePolicy None() => new(BatterySavePersistenceMode.None, null);

    public static BatterySavePolicy PerProfile(int profileId) => new(BatterySavePersistenceMode.PerProfile, profileId);
}
