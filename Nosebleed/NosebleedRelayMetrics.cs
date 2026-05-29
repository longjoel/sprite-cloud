using System.Collections.Concurrent;
using System.Threading;

namespace games_vault.Nosebleed;

public sealed class NosebleedRelayMetrics
{
    private readonly ConcurrentDictionary<string, ChannelCounters> _channels = new(StringComparer.OrdinalIgnoreCase);

    public void RecordReceived(string channel, int bytes)
    {
        var counters = GetCounters(channel);
        Interlocked.Increment(ref counters.MessagesReceived);
        Interlocked.Add(ref counters.BytesReceived, bytes);
    }

    public void RecordForwarded(string channel, int bytes)
    {
        var counters = GetCounters(channel);
        Interlocked.Increment(ref counters.MessagesForwarded);
        Interlocked.Add(ref counters.BytesForwarded, bytes);
    }

    public void RecordDropped(string channel, int bytes)
    {
        var counters = GetCounters(channel);
        Interlocked.Increment(ref counters.MessagesDropped);
        Interlocked.Add(ref counters.BytesDropped, bytes);
    }

    public NosebleedRelaySnapshot GetSnapshot(string channel)
    {
        var counters = GetCounters(channel);
        return new NosebleedRelaySnapshot(
            channel,
            Interlocked.Read(ref counters.MessagesReceived),
            Interlocked.Read(ref counters.MessagesForwarded),
            Interlocked.Read(ref counters.MessagesDropped),
            Interlocked.Read(ref counters.BytesReceived),
            Interlocked.Read(ref counters.BytesForwarded),
            Interlocked.Read(ref counters.BytesDropped));
    }

    private ChannelCounters GetCounters(string channel)
        => _channels.GetOrAdd(string.IsNullOrWhiteSpace(channel) ? "unknown" : channel.Trim().ToLowerInvariant(), _ => new ChannelCounters());

    private sealed class ChannelCounters
    {
        public long MessagesReceived;
        public long MessagesForwarded;
        public long MessagesDropped;
        public long BytesReceived;
        public long BytesForwarded;
        public long BytesDropped;
    }
}

public sealed record NosebleedRelaySnapshot(
    string Channel,
    long MessagesReceived,
    long MessagesForwarded,
    long MessagesDropped,
    long BytesReceived,
    long BytesForwarded,
    long BytesDropped);
