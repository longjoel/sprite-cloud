using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;

namespace games_vault.Gameplay;

public sealed record RoomCreateResult(bool Success, GamePlayRoom? Room, NosebleedSession? Session, string? Error, IReadOnlyList<ProfileBatterySaveLogEntry> Diagnostics)
{
    public static RoomCreateResult Fail(string error) => new(false, null, null, error, []);
    public static RoomCreateResult Ok(GamePlayRoom room, NosebleedSession session, IReadOnlyList<ProfileBatterySaveLogEntry>? diagnostics = null) => new(true, room, session, null, diagnostics ?? []);
}

public sealed record RoomJoinResult(bool Success, GamePlayRoom? Room, NosebleedSession? Session, NosebleedSeatAssignment? Seat, string? Token, string? Error)
{
    public static RoomJoinResult Fail(string error) => new(false, null, null, null, null, error);
    public static RoomJoinResult Ok(GamePlayRoom room, NosebleedSession session, NosebleedSeatAssignment seat, string token) => new(true, room, session, seat, token, null);
}

public sealed record RoomPresencePlayer(string DisplayName, int PlayerNumber, int? Port);

public sealed record RoomPresenceWatcher(string DisplayName);

public sealed record RoomPresenceSnapshot(
    IReadOnlyList<RoomPresencePlayer> Players,
    IReadOnlyList<RoomPresenceWatcher> Watchers,
    int WatcherCount,
    int TotalConnected);

public sealed record RoomChatMessageSnapshot(string DisplayName, string Message, DateTime CreatedUtc);

public sealed record RoomChatSnapshot(IReadOnlyList<RoomChatMessageSnapshot> Messages);

public sealed record RoomChatPostResult(bool Success, GamePlayRoomChatMessage? Message, string? Error)
{
    public static RoomChatPostResult Fail(string error) => new(false, null, error);
    public static RoomChatPostResult Ok(GamePlayRoomChatMessage message) => new(true, message, null);
}

public sealed record RoomBatterySaveFlushResult(bool Success, int CapturedCount, string? Message, string? Error)
{
    public static RoomBatterySaveFlushResult Fail(string error) => new(false, 0, null, error);
    public static RoomBatterySaveFlushResult Ok(int capturedCount, string message) => new(true, capturedCount, message, null);
}
