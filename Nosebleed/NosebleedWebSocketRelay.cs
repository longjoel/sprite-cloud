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
        => GetUpstreamMode(channel) == NosebleedRelayMode.LatestOnly
            ? PumpLatestOnlyAsync(source, destination, cancellationToken)
            : PumpOrderedAsync(source, destination, cancellationToken);

    public static async Task PumpOrderedAsync(WebSocket source, WebSocket destination, CancellationToken cancellationToken)
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

            await destination.SendAsync(
                new ArraySegment<byte>(message.Payload),
                message.MessageType,
                true,
                cancellationToken);
        }
    }

    public static async Task PumpLatestOnlyAsync(WebSocket source, WebSocket destination, CancellationToken cancellationToken)
    {
        var queue = Channel.CreateBounded<RelayMessage>(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.DropOldest
        });

        RelayMessage? closeFrame = null;

        var reader = Task.Run(async () =>
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested &&
                       source.State == WebSocketState.Open &&
                       (destination.State == WebSocketState.Open || destination.State == WebSocketState.CloseReceived))
                {
                    var message = await ReceiveCompleteMessageAsync(source, cancellationToken);
                    if (message.IsClose)
                    {
                        closeFrame = message;
                        break;
                    }

                    while (!queue.Writer.TryWrite(message))
                    {
                        if (!await queue.Writer.WaitToWriteAsync(cancellationToken))
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
        }, cancellationToken);

        var writer = Task.Run(async () =>
        {
            await foreach (var message in queue.Reader.ReadAllAsync(cancellationToken))
            {
                await destination.SendAsync(
                    new ArraySegment<byte>(message.Payload),
                    message.MessageType,
                    true,
                    cancellationToken);
            }
        }, cancellationToken);

        await reader;
        await writer;

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
