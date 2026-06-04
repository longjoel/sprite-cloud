using games_vault.Models;

namespace games_vault.Gameplay;

public sealed class BatterySavePolicyResolver
{
    public BatterySavePolicy Resolve(GamePlayRoom room, UserProfile? profile)
    {
        ArgumentNullException.ThrowIfNull(room);

        if (room.IsArcadeBound)
        {
            return BatterySavePolicy.None();
        }

        if (profile is null || profile.IsEphemeral)
        {
            return BatterySavePolicy.None();
        }

        return BatterySavePolicy.PerProfile(profile.Id);
    }
}
