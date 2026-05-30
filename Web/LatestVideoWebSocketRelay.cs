using System.Net.WebSockets;
using System.Threading.Channels;

namespace games_vault.Web;

public static class LatestVideoWebSocketRelay
{
    public static async Task PumpLatestAsync(
        WebSocket source,
        WebSocket destination,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var messages = Channel.CreateBounded<BufferedWebSocketMessage>(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.DropOldest
        });

        var receiveTask = ReceiveLatestMessagesAsync(source, messages.Writer, linkedCts.Token);
        var sendTask = SendMessagesAsync(destination, messages.Reader, linkedCts.Token);

        var completed = await Task.WhenAny(receiveTask, sendTask);
        if (completed == sendTask)
        {
            await linkedCts.CancelAsync();
        }

        await AwaitIgnoringCancellationAsync(receiveTask, linkedCts.Token);
        await AwaitIgnoringCancellationAsync(sendTask, linkedCts.Token);

        if ((destination.State == WebSocketState.Open || destination.State == WebSocketState.CloseReceived) &&
            source.State != WebSocketState.Open)
        {
            await destination.CloseAsync(WebSocketCloseStatus.NormalClosure, null, cancellationToken);
        }
    }

    private static async Task ReceiveLatestMessagesAsync(
        WebSocket source,
        ChannelWriter<BufferedWebSocketMessage> writer,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024];

        try
        {
            while (!cancellationToken.IsCancellationRequested && source.State == WebSocketState.Open)
            {
                var message = await ReadCompleteMessageAsync(source, buffer, cancellationToken);
                if (message is null)
                {
                    break;
                }

                if (!writer.TryWrite(message))
                {
                    break;
                }
            }
        }
        finally
        {
            writer.TryComplete();
        }
    }

    private static async Task SendMessagesAsync(
        WebSocket destination,
        ChannelReader<BufferedWebSocketMessage> reader,
        CancellationToken cancellationToken)
    {
        await foreach (var message in reader.ReadAllAsync(cancellationToken))
        {
            if (destination.State != WebSocketState.Open)
            {
                break;
            }

            await destination.SendAsync(message.Payload, message.MessageType, true, cancellationToken);
        }
    }

    private static async Task<BufferedWebSocketMessage?> ReadCompleteMessageAsync(
        WebSocket source,
        byte[] buffer,
        CancellationToken cancellationToken)
    {
        using var payload = new MemoryStream();
        WebSocketMessageType? messageType = null;

        while (true)
        {
            var result = await source.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            messageType ??= result.MessageType;
            if (result.Count > 0)
            {
                await payload.WriteAsync(buffer.AsMemory(0, result.Count), cancellationToken);
            }

            if (result.EndOfMessage)
            {
                return new BufferedWebSocketMessage(messageType.Value, payload.ToArray());
            }
        }
    }

    private static async Task AwaitIgnoringCancellationAsync(Task task, CancellationToken cancellationToken)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private sealed record BufferedWebSocketMessage(WebSocketMessageType MessageType, byte[] Payload);
}
