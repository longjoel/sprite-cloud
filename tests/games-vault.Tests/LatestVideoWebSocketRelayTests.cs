using System.Net.WebSockets;
using System.Text;
using games_vault.Web;

namespace games_vault.Tests;

public sealed class LatestVideoWebSocketRelayTests
{
    [Fact]
    public async Task PumpLatestAsync_ReassemblesFragmentedMessagesBeforeForwarding()
    {
        using var source = FakeSourceWebSocket.Binary(
            chunk("hel", endOfMessage: false),
            chunk("lo", endOfMessage: true),
            close());
        using var destination = new RecordingDestinationWebSocket();

        await LatestVideoWebSocketRelay.PumpLatestAsync(source, destination, CancellationToken.None);

        var sent = Assert.Single(destination.SentMessages);
        Assert.Equal(WebSocketMessageType.Binary, sent.MessageType);
        Assert.True(sent.EndOfMessage);
        Assert.Equal("hello", Encoding.UTF8.GetString(sent.Payload));
    }

    [Fact]
    public async Task PumpLatestAsync_DropsOlderQueuedMessagesWhenNewerFrameArrives()
    {
        using var destination = new RecordingDestinationWebSocket(blockFirstSend: true);
        using var source = FakeSourceWebSocket.BinaryPausedAfter(
            pauseAfterReceiveCount: 2,
            resumeWhen: destination.FirstSendStarted,
            chunk("frame-1", endOfMessage: true),
            chunk("frame-2", endOfMessage: true),
            close());

        var relayTask = LatestVideoWebSocketRelay.PumpLatestAsync(source, destination, CancellationToken.None);

        await destination.FirstSendStarted;
        Assert.Empty(destination.SentMessages);

        destination.ReleaseFirstSend();
        await relayTask;

        Assert.Equal(2, destination.SentMessages.Count);
        Assert.Equal("frame-1", Encoding.UTF8.GetString(destination.SentMessages[0].Payload));
        Assert.Equal("frame-2", Encoding.UTF8.GetString(destination.SentMessages[1].Payload));
    }

    [Fact]
    public async Task PumpLatestAsync_KeepsOnlyNewestPendingFrameWhileDestinationIsBusy()
    {
        using var destination = new RecordingDestinationWebSocket(blockFirstSend: true);
        using var source = FakeSourceWebSocket.BinaryPausedAfter(
            pauseAfterReceiveCount: 2,
            resumeWhen: destination.FirstSendStarted,
            chunk("frame-1", endOfMessage: true),
            chunk("frame-2", endOfMessage: true),
            chunk("frame-3", endOfMessage: true),
            close());

        var relayTask = LatestVideoWebSocketRelay.PumpLatestAsync(source, destination, CancellationToken.None);

        await destination.FirstSendStarted;
        destination.ReleaseFirstSend();
        await relayTask;

        Assert.Equal(2, destination.SentMessages.Count);
        Assert.Equal("frame-1", Encoding.UTF8.GetString(destination.SentMessages[0].Payload));
        Assert.Equal("frame-3", Encoding.UTF8.GetString(destination.SentMessages[1].Payload));
    }

    private static FakeReceive chunk(string payload, bool endOfMessage, WebSocketMessageType messageType = WebSocketMessageType.Binary)
        => new(messageType, Encoding.UTF8.GetBytes(payload), endOfMessage);

    private static FakeReceive close() => FakeReceive.Close();

    private sealed class FakeSourceWebSocket : WebSocket
    {
        private readonly Queue<FakeReceive> receives;
        private readonly int? pauseAfterReceiveCount;
        private readonly Task? resumeWhen;
        private int receiveCount;

        private FakeSourceWebSocket(
            IEnumerable<FakeReceive> receives,
            int? pauseAfterReceiveCount = null,
            Task? resumeWhen = null)
        {
            this.receives = new Queue<FakeReceive>(receives);
            this.pauseAfterReceiveCount = pauseAfterReceiveCount;
            this.resumeWhen = resumeWhen;
        }

        public static FakeSourceWebSocket Binary(params FakeReceive[] receives) => new(receives);

        public static FakeSourceWebSocket BinaryPausedAfter(int pauseAfterReceiveCount, Task resumeWhen, params FakeReceive[] receives)
            => new(receives, pauseAfterReceiveCount, resumeWhen);

        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => receives.Count > 0 ? WebSocketState.Open : WebSocketState.Closed;
        public override string SubProtocol => string.Empty;

        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Dispose() { }
        public override async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
        {
            if (receives.Count == 0)
            {
                return new WebSocketReceiveResult(0, WebSocketMessageType.Close, true);
            }

            var next = receives.Dequeue();
            receiveCount += 1;
            if (pauseAfterReceiveCount == receiveCount && resumeWhen is not null)
            {
                await resumeWhen.WaitAsync(cancellationToken);
            }

            next.Payload.CopyTo(buffer);
            return new WebSocketReceiveResult(next.Payload.Count, next.MessageType, next.EndOfMessage);
        }

        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
            => throw new NotSupportedException();
    }

    private sealed class RecordingDestinationWebSocket(bool blockFirstSend = false) : WebSocket
    {
        private readonly TaskCompletionSource firstSendStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource firstSendReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int sendCount;

        public List<SentMessage> SentMessages { get; } = [];
        public Task FirstSendStarted => firstSendStarted.Task;

        public void ReleaseFirstSend() => firstSendReleased.TrySetResult();

        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string SubProtocol => string.Empty;

        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
            => Task.FromResult(new WebSocketReceiveResult(0, WebSocketMessageType.Close, true));

        public override async Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            if (blockFirstSend && Interlocked.Increment(ref sendCount) == 1)
            {
                firstSendStarted.TrySetResult();
                await firstSendReleased.Task.WaitAsync(cancellationToken);
            }

            var payload = buffer.Array is null
                ? buffer.ToArray()
                : buffer.Array.Skip(buffer.Offset).Take(buffer.Count).ToArray();
            SentMessages.Add(new SentMessage(messageType, endOfMessage, payload));
        }
    }

    private sealed record FakeReceive(WebSocketMessageType MessageType, ArraySegment<byte> Payload, bool EndOfMessage)
    {
        public static FakeReceive Close() => new(WebSocketMessageType.Close, ArraySegment<byte>.Empty, true);

        public FakeReceive(WebSocketMessageType messageType, byte[] payload, bool endOfMessage)
            : this(messageType, new ArraySegment<byte>(payload), endOfMessage)
        {
        }
    }

    public sealed record SentMessage(WebSocketMessageType MessageType, bool EndOfMessage, byte[] Payload);
}
