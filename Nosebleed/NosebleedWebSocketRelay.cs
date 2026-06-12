using System.Net.WebSockets;
using System.Threading.Channels;

namespace games_vault.Nosebleed;

public enum NosebleedRelayMode
{
    Ordered,
    LatestOnly
}

public static class NosebleedWebSocketRelay
{
    public static NosebleedRelayMode GetUpstreamMode(string channel)
        => string.Equals(channel?.Trim(), "video", StringComparison.OrdinalIgnoreCase)
            ? NosebleedRelayMode.LatestOnly
            : NosebleedRelayMode.Ordered;

    public static Task PumpUpstreamToDownstreamAsync(string channel, WebSocket source, WebSocket destination, CancellationToken cancellationToken)
        => PumpUpstreamToDownstreamAsync(channel, source, destination, metrics: null, cancellationToken);

    public static Task PumpUpstreamToDownstreamAsync(string channel, WebSocket source, WebSocket destination, NosebleedRelayMetrics? metrics, CancellationToken cancellationToken)
        => GetUpstreamMode(channel) == NosebleedRelayMode.LatestOnly
            ? PumpLatestOnlyAsync(source, destination, channel, metrics, cancellationToken)
            : PumpOrderedAsync(source, destination, channel, metrics, cancellationToken);

    public static Task PumpOrderedAsync(WebSocket source, WebSocket destination, CancellationToken cancellationToken)
        => PumpOrderedAsync(source, destination, "unknown", metrics: null, cancellationToken);

    public static async Task PumpOrderedAsync(WebSocket source, WebSocket destination, string channel, NosebleedRelayMetrics? metrics, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested &&
               source.State == WebSocketState.Open &&
               destination.State == WebSocketState.Open)
        {
            var message = await ReceiveCompleteMessageAsync(source, cancellationToken);
            if (message.IsClose)
            {
                if (destination.State == WebSocketState.Open || destination.State == WebSocketState.CloseReceived)
                {
                    await destination.CloseAsync(
                        message.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                        message.CloseStatusDescription,
                        cancellationToken);
                }

                break;
            }

            metrics?.RecordReceived(channel, message.Payload.Length);
            await destination.SendAsync(
                new ArraySegment<byte>(message.Payload),
                message.MessageType,
                true,
                cancellationToken);
            metrics?.RecordForwarded(channel, message.Payload.Length);
        }
    }

    public static Task PumpLatestOnlyAsync(WebSocket source, WebSocket destination, CancellationToken cancellationToken)
        => PumpLatestOnlyAsync(source, destination, "video", metrics: null, cancellationToken);

    public static async Task PumpLatestOnlyAsync(WebSocket source, WebSocket destination, string channel, NosebleedRelayMetrics? metrics, CancellationToken cancellationToken)
    {
        var queue = Channel.CreateBounded<RelayMessage>(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.Wait
        });

        RelayMessage? closeFrame = null;
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        var reader = Task.Run(async () =>
        {
            try
            {
                while (!linkedCts.Token.IsCancellationRequested &&
                       source.State == WebSocketState.Open &&
                       (destination.State == WebSocketState.Open || destination.State == WebSocketState.CloseReceived))
                {
                    var message = await ReceiveCompleteMessageAsync(source, linkedCts.Token);
                    if (message.IsClose)
                    {
                        closeFrame = message;
                        break;
                    }

                    metrics?.RecordReceived(channel, message.Payload.Length);
                    while (!queue.Writer.TryWrite(message))
                    {
                        if (queue.Reader.TryRead(out var dropped))
                        {
                            metrics?.RecordDropped(channel, dropped.Payload.Length);
                            continue;
                        }

                        if (!await queue.Writer.WaitToWriteAsync(linkedCts.Token))
                        {
                            return;
                        }
                    }
                }
            }
            finally
            {
                queue.Writer.TryComplete();
            }
        }, linkedCts.Token);

        var writer = Task.Run(async () =>
        {
            await foreach (var message in queue.Reader.ReadAllAsync(linkedCts.Token))
            {
                await destination.SendAsync(
                    new ArraySegment<byte>(message.Payload),
                    message.MessageType,
                    true,
                    linkedCts.Token);
                metrics?.RecordForwarded(channel, message.Payload.Length);
            }
        }, linkedCts.Token);

        try
        {
            await Task.WhenAll(reader, writer);
        }
        catch
        {
            linkedCts.Cancel();
            throw;
        }

        if (closeFrame is not null && (destination.State == WebSocketState.Open || destination.State == WebSocketState.CloseReceived))
        {
            await destination.CloseAsync(
                closeFrame.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                closeFrame.CloseStatusDescription,
                cancellationToken);
        }
    }

    private static async Task<RelayMessage> ReceiveCompleteMessageAsync(WebSocket source, CancellationToken cancellationToken)
    {
        var chunk = new byte[64 * 1024];
        using var stream = new MemoryStream();

        while (true)
        {
            var result = await source.ReceiveAsync(new ArraySegment<byte>(chunk), cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return RelayMessage.Close(result.CloseStatus, result.CloseStatusDescription);
            }

            if (result.Count > 0)
            {
                await stream.WriteAsync(chunk.AsMemory(0, result.Count), cancellationToken);
            }

            if (result.EndOfMessage)
            {
                return RelayMessage.Data(stream.ToArray(), result.MessageType);
            }
        }
    }

    private sealed record RelayMessage(
        byte[] Payload,
        WebSocketMessageType MessageType,
        bool IsClose,
        WebSocketCloseStatus? CloseStatus,
        string? CloseStatusDescription)
    {
        public static RelayMessage Data(byte[] payload, WebSocketMessageType messageType)
            => new(payload, messageType, false, null, null);

        public static RelayMessage Close(WebSocketCloseStatus? closeStatus, string? description)
            => new([], WebSocketMessageType.Close, true, closeStatus, description);
    }
}
