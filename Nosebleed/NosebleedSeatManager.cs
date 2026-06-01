using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedSeatManager(IOptions<NosebleedOptions> options)
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();
    private readonly ConcurrentDictionary<string, SessionSeatState> _sessions = new(StringComparer.OrdinalIgnoreCase);

    public NosebleedSeatAssignment Assign(string sessionId, string viewerId, DateTimeOffset now, bool allowPlayer = true)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(viewerId);

        var session = _sessions.GetOrAdd(sessionId, _ => new SessionSeatState());
        lock (session.Gate)
        {
            CleanupExpired(session.Seats, now);

            var existing = session.Seats.FirstOrDefault(s => string.Equals(s.ViewerId, viewerId, StringComparison.Ordinal));
            if (allowPlayer && existing is { Kind: NosebleedSeatKind.Player })
            {
                session.Seats.Remove(existing);
                var refreshed = existing with { ExpiresUtc = now.AddMinutes(SeatTtlMinutes()) };
                session.Seats.Add(refreshed);
                return refreshed;
            }

            var expiresUtc = now.AddMinutes(SeatTtlMinutes());

            if (existing is not null)
            {
                session.Seats.Remove(existing);
            }

            NosebleedSeatAssignment assignment;
            if (!allowPlayer)
            {
                assignment = new NosebleedSeatAssignment(NosebleedSeatKind.Spectator, viewerId, null, now, expiresUtc);
            }
            else
            {
                var maxPlayers = Math.Clamp(_options.MaxPlayersPerSession, 1, 4);
                var freePort = FindFreePort(session.Seats, maxPlayers);
                assignment = freePort >= 0
                    ? new NosebleedSeatAssignment(NosebleedSeatKind.Player, viewerId, freePort, now, expiresUtc)
                    : new NosebleedSeatAssignment(NosebleedSeatKind.Spectator, viewerId, null, now, expiresUtc);
            }

            session.Seats.Add(assignment);
            return assignment;
        }
    }

    public void Release(string sessionId, string viewerId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(viewerId))
        {
            return;
        }

        if (!_sessions.TryGetValue(sessionId, out var session))
        {
            return;
        }

        lock (session.Gate)
        {
            session.Seats.RemoveAll(s => string.Equals(s.ViewerId, viewerId, StringComparison.Ordinal));
        }
    }

    public IReadOnlyList<NosebleedSeatAssignment> GetAssignments(string sessionId, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || !_sessions.TryGetValue(sessionId, out var session))
        {
            return [];
        }

        lock (session.Gate)
        {
            CleanupExpired(session.Seats, now);
            return session.Seats
                .OrderBy(x => x.Kind == NosebleedSeatKind.Spectator ? 1 : 0)
                .ThenBy(x => x.Port ?? int.MaxValue)
                .ThenBy(x => x.AssignedUtc)
                .ToList();
        }
    }

    private int SeatTtlMinutes() => Math.Max(1, _options.SeatTtlMinutes);

    private static int FindFreePort(List<NosebleedSeatAssignment> seats, int maxPlayers)
    {
        var usedPorts = seats
            .Where(s => s.Kind == NosebleedSeatKind.Player && s.Port is not null)
            .Select(s => s.Port!.Value)
            .ToHashSet();
        return Enumerable.Range(0, maxPlayers).FirstOrDefault(p => !usedPorts.Contains(p), -1);
    }

    private static void CleanupExpired(List<NosebleedSeatAssignment> seats, DateTimeOffset now)
        => seats.RemoveAll(s => s.ExpiresUtc <= now);

    private sealed class SessionSeatState
    {
        public object Gate { get; } = new();
        public List<NosebleedSeatAssignment> Seats { get; } = [];
    }
}
