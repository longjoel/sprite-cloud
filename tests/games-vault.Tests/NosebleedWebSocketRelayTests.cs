using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using games_vault.Nosebleed;

namespace games_vault.Tests;

public sealed class NosebleedWebSocketRelayTests
{
    [Theory]
    [InlineData("video", NosebleedRelayMode.LatestOnly)]
    [InlineData("audio", NosebleedRelayMode.Ordered)]
    [InlineData("input", NosebleedRelayMode.Ordered)]
    public void GetUpstreamMode_ReturnsExpectedPolicy(string channel, NosebleedRelayMode expected)
    {
        Assert.Equal(expected, NosebleedWebSocketRelay.GetUpstreamMode(channel));
    }

    [Fact]
    public async Task PumpOrderedAsync_ForwardsEveryAudioMessageInOrder()
    {
        var source = FakeWebSocket.FromBinaryMessages("a1", "a2");
        var destination = new FakeWebSocket();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));

        await NosebleedWebSocketRelay.PumpOrderedAsync(source, destination, cts.Token);

        Assert.Equal(["a1", "a2"], destination.GetSentBinaryMessages());
    }

    [Fact]
    public async Task PumpLatestOnlyAsync_DropsStaleQueuedVideoMessagesUnderBackpressure()
    {
        var source = FakeWebSocket.FromBinaryMessages("v1", "v2", "v3");
        var destination = new FakeWebSocket(sendDelay: TimeSpan.FromMilliseconds(100));
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));

        await NosebleedWebSocketRelay.PumpLatestOnlyAsync(source, destination, cts.Token);

        var sent = destination.GetSentBinaryMessages();
        Assert.DoesNotContain("v2", sent);
        Assert.Equal("v3", sent[^1]);
    }

    private sealed class FakeWebSocket : WebSocket
    {
        private readonly Queue<ReceiveFrame> _receiveFrames = new();
        private readonly ConcurrentQueue<SentFrame> _sentFrames = new();
        private readonly TimeSpan _sendDelay;
        private WebSocketState _state = WebSocketState.Open;
        private WebSocketCloseStatus? _closeStatus;
        private string? _closeStatusDescription;

        public FakeWebSocket(TimeSpan? sendDelay = null)
        {
            _sendDelay = sendDelay ?? TimeSpan.Zero;
        }

        public override WebSocketCloseStatus? CloseStatus => _closeStatus;

        public override string? CloseStatusDescription => _closeStatusDescription;

        public override WebSocketState State => _state;

        public override string SubProtocol => string.Empty;

        public override void Abort() => _state = WebSocketState.Aborted;

        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            _closeStatus = closeStatus;
            _closeStatusDescription = statusDescription;
            _state = WebSocketState.Closed;
            return Task.CompletedTask;
        }

        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            _closeStatus = closeStatus;
            _closeStatusDescription = statusDescription;
            _state = WebSocketState.CloseSent;
            return Task.CompletedTask;
        }

        public override void Dispose()
        {
            _state = WebSocketState.Closed;
        }

        public override async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_receiveFrames.Count == 0)
            {
                _state = WebSocketState.CloseReceived;
                return new WebSocketReceiveResult(0, WebSocketMessageType.Close, true);
            }

            var frame = _receiveFrames.Dequeue();
            frame.Payload.CopyTo(buffer);
            if (frame.MessageType == WebSocketMessageType.Close)
            {
                _state = WebSocketState.CloseReceived;
            }

            await Task.Yield();
            return new WebSocketReceiveResult(frame.Payload.Count, frame.MessageType, frame.EndOfMessage);
        }

        public override async Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_sendDelay > TimeSpan.Zero)
            {
                await Task.Delay(_sendDelay, cancellationToken);
            }

            var copy = buffer.ToArray();
            _sentFrames.Enqueue(new SentFrame(copy, messageType, endOfMessage));
        }

        public IReadOnlyList<string> GetSentBinaryMessages()
        {
            return _sentFrames
                .Where(x => x.MessageType == WebSocketMessageType.Binary && x.EndOfMessage)
                .Select(x => Encoding.UTF8.GetString(x.Payload))
                .ToList();
        }

        public static FakeWebSocket FromBinaryMessages(params string[] payloads)
        {
            var socket = new FakeWebSocket();
            foreach (var payload in payloads)
            {
                socket._receiveFrames.Enqueue(new ReceiveFrame(
                    new ArraySegment<byte>(Encoding.UTF8.GetBytes(payload)),
                    WebSocketMessageType.Binary,
                    true));
            }

            socket._receiveFrames.Enqueue(new ReceiveFrame(ArraySegment<byte>.Empty, WebSocketMessageType.Close, true));
            return socket;
        }

        private sealed record ReceiveFrame(ArraySegment<byte> Payload, WebSocketMessageType MessageType, bool EndOfMessage);
        private sealed record SentFrame(byte[] Payload, WebSocketMessageType MessageType, bool EndOfMessage);
    }
}
