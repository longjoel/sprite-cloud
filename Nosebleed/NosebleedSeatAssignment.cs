namespace games_vault.Nosebleed;

public enum NosebleedSeatKind
{
    Player,
    Spectator
}

public sealed record NosebleedSeatAssignment(
    NosebleedSeatKind Kind,
    string ViewerId,
    int? Port,
    DateTimeOffset AssignedUtc,
    DateTimeOffset ExpiresUtc)
{
    public int? PlayerNumber => Port is null ? null : Port.Value + 1;
}
