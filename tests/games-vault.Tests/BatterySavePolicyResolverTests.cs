using games_vault.Gameplay;
using games_vault.Models;

namespace games_vault.Tests;

public sealed class BatterySavePolicyResolverTests
{
    private readonly BatterySavePolicyResolver _resolver = new();

    [Fact]
    public void Resolve_returns_none_for_arcade_room_even_with_persistent_profile()
    {
        var room = new GamePlayRoom { IsArcadeBound = true };
        var profile = CreateProfile(id: 12, isEphemeral: false);

        var policy = _resolver.Resolve(room, profile);

        Assert.Equal(BatterySavePersistenceMode.None, policy.Mode);
        Assert.Null(policy.ProfileId);
    }

    [Fact]
    public void Resolve_returns_per_profile_for_non_arcade_persistent_profile()
    {
        var room = new GamePlayRoom { IsArcadeBound = false };
        var profile = CreateProfile(id: 12, isEphemeral: false);

        var policy = _resolver.Resolve(room, profile);

        Assert.Equal(BatterySavePersistenceMode.PerProfile, policy.Mode);
        Assert.Equal(12, policy.ProfileId);
    }

    [Fact]
    public void Resolve_returns_none_for_non_arcade_room_without_profile()
    {
        var room = new GamePlayRoom { IsArcadeBound = false };

        var policy = _resolver.Resolve(room, profile: null);

        Assert.Equal(BatterySavePersistenceMode.None, policy.Mode);
        Assert.Null(policy.ProfileId);
    }

    [Fact]
    public void Resolve_returns_none_for_ephemeral_profile()
    {
        var room = new GamePlayRoom { IsArcadeBound = false };
        var profile = CreateProfile(id: 19, isEphemeral: true);

        var policy = _resolver.Resolve(room, profile);

        Assert.Equal(BatterySavePersistenceMode.None, policy.Mode);
        Assert.Null(policy.ProfileId);
    }

    private static UserProfile CreateProfile(int id, bool isEphemeral) => new()
    {
        Id = id,
        DisplayName = $"Profile {id}",
        PasskeyUserHandleBase64Url = $"handle-{id}",
        IsEphemeral = isEphemeral,
        CreatedUtc = DateTime.UtcNow,
        UpdatedUtc = DateTime.UtcNow
    };
}
