using games_vault.Data;
using games_vault.Models;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Gameplay;

public sealed class GamePlayRoomService(
    AppDbContext db,
    RoomCodeGenerator roomCodes,
    NosebleedSessionManager nosebleedSessions,
    NosebleedSeatManager nosebleedSeats,
    NosebleedTicketSigner nosebleedTickets,
    CurrentAccessService currentAccess,
    CurrentProfileService currentProfile)
{
    public async Task<IReadOnlyList<GamePlayRoom>> ListActiveRoomsForGameAsync(int gameId, CancellationToken ct)
    {
        return await db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.GameId == gameId && x.Status == GamePlayRoomStatus.Active)
            .OrderByDescending(x => x.LastActiveUtc)
            .ToListAsync(ct);
    }

    public async Task<RoomCreateResult> CreateRoomAsync(int gameId, int gameFileId, string systemName, string contentPath, CancellationToken ct)
    {
        if (!await currentAccess.CanPlayAsync(ct))
        {
            return RoomCreateResult.Fail("Sign in with a player profile to create a room.");
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        var code = await GenerateUniqueCodeAsync(ct);
        var room = new GamePlayRoom
        {
            Code = code,
            GameId = gameId,
            GameFileId = gameFileId,
            CreatedByProfileId = profile?.Id,
            Status = GamePlayRoomStatus.Active,
            CreatedUtc = DateTime.UtcNow,
            LastActiveUtc = DateTime.UtcNow
        };

        db.GamePlayRooms.Add(room);
        await db.SaveChangesAsync(ct);

        var start = await nosebleedSessions.StartOrReuseAsync(
            gameId,
            gameFileId,
            systemName,
            contentPath,
            ct,
            $"room:{room.Id}");

        if (!start.Success || start.Session is null)
        {
            room.Status = GamePlayRoomStatus.Closed;
            room.ClosedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return RoomCreateResult.Fail(start.Error ?? "Failed to start room session.");
        }

        room.NosebleedSessionId = start.Session.Id;
        room.LastActiveUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        return RoomCreateResult.Ok(room, start.Session);
    }

    public async Task<RoomJoinResult> JoinByCodeAsync(string rawCode, string viewerId, CancellationToken ct)
    {
        var code = NormalizeCode(rawCode);
        if (code is null)
        {
            return RoomJoinResult.Fail("Session code must be exactly 4 letters.");
        }

        var room = await db.GamePlayRooms
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .FirstOrDefaultAsync(x => x.Code == code && x.Status == GamePlayRoomStatus.Active, ct);

        if (room is null)
        {
            return RoomJoinResult.Fail("No active room found for that code.");
        }

        nosebleedSessions.Cleanup();
        var session = nosebleedSessions.GetSessions().FirstOrDefault(x => x.SessionId == room.NosebleedSessionId && !x.HasExited);
        if (session is null)
        {
            room.Status = GamePlayRoomStatus.Closed;
            room.ClosedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return RoomJoinResult.Fail("That room is no longer active.");
        }

        var now = DateTimeOffset.UtcNow;
        var canPlay = await currentAccess.CanPlayAsync(ct);
        var seat = nosebleedSeats.Assign(session.SessionId, viewerId, now, allowPlayer: canPlay);

        var profile = await currentProfile.GetCurrentAsync(ct);
        var participant = await db.GamePlayRoomParticipants.FirstOrDefaultAsync(x => x.RoomId == room.Id && x.ViewerId == viewerId, ct);
        if (participant is null)
        {
            participant = new GamePlayRoomParticipant
            {
                RoomId = room.Id,
                ViewerId = viewerId,
                JoinedUtc = DateTime.UtcNow
            };
            db.GamePlayRoomParticipants.Add(participant);
        }

        participant.ProfileId = profile?.Id;
        participant.DisplayNameSnapshot = profile?.DisplayName;
        participant.Role = seat.Kind == NosebleedSeatKind.Player ? GamePlayRoomParticipantRole.Player : GamePlayRoomParticipantRole.Spectator;
        participant.Port = seat.Port;
        participant.IsConnected = true;
        participant.LastSeenUtc = DateTime.UtcNow;

        room.LastActiveUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        var token = seat.Kind == NosebleedSeatKind.Player && seat.Port is not null && canPlay
            ? nosebleedTickets.CreatePlayerToken(session.SessionId, viewerId, seat.Port.Value)
            : nosebleedTickets.CreateSpectatorToken(session.SessionId, viewerId);
        token ??= nosebleedTickets.CreateSpectatorToken(session.SessionId, viewerId) ?? string.Empty;

        var playableSession = new NosebleedSession(
            session.SessionId,
            session.GameId,
            session.FileId,
            session.Port,
            session.BaseUrl,
            token,
            session.StartedUtc,
            session.CorePath,
            session.ContentPath);

        return RoomJoinResult.Ok(room, playableSession, seat, token);
    }

    private async Task<string> GenerateUniqueCodeAsync(CancellationToken ct)
    {
        for (var i = 0; i < 64; i++)
        {
            var candidate = roomCodes.NextCode();
            var exists = await db.GamePlayRooms.AnyAsync(x => x.Code == candidate && x.Status == GamePlayRoomStatus.Active, ct);
            if (!exists)
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("Failed to allocate a unique room code.");
    }

    public static string? NormalizeCode(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return null;
        }

        var normalized = new string(code.Trim().ToUpperInvariant().Where(char.IsLetter).ToArray());
        return normalized.Length == 4 ? normalized : null;
    }

    public async Task<RoomChatPostResult> AddChatMessageAsync(int roomId, string? rawMessage, CancellationToken ct)
    {
        if (!await currentAccess.CanPlayAsync(ct))
        {
            return RoomChatPostResult.Fail("Sign in with a player profile to chat.");
        }

        var messageText = NormalizeChatMessage(rawMessage);
        if (string.IsNullOrWhiteSpace(messageText))
        {
            return RoomChatPostResult.Fail("Enter a chat message.");
        }

        if (messageText.Length > 280)
        {
            return RoomChatPostResult.Fail("Chat messages must be 280 characters or less.");
        }

        var room = await db.GamePlayRooms.FirstOrDefaultAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, ct);
        if (room is null)
        {
            return RoomChatPostResult.Fail("That room is no longer active.");
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        if (profile is null)
        {
            return RoomChatPostResult.Fail("Sign in with a player profile to chat.");
        }

        var chatMessage = new GamePlayRoomChatMessage
        {
            RoomId = room.Id,
            ProfileId = profile.Id,
            DisplayNameSnapshot = string.IsNullOrWhiteSpace(profile.DisplayName) ? "Player" : profile.DisplayName.Trim(),
            Message = messageText,
            CreatedUtc = DateTime.UtcNow
        };

        db.GamePlayRoomChatMessages.Add(chatMessage);
        room.LastActiveUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return RoomChatPostResult.Ok(chatMessage);
    }

    public static RoomPresenceSnapshot BuildPresenceSnapshot(
        IReadOnlyList<NosebleedSeatAssignment> assignments,
        IReadOnlyList<GamePlayRoomParticipant> participants)
    {
        var participantsByViewer = participants
            .GroupBy(x => x.ViewerId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(x => x.LastSeenUtc).First(), StringComparer.Ordinal);

        var players = assignments
            .Where(x => x.Kind == NosebleedSeatKind.Player)
            .OrderBy(x => x.PlayerNumber ?? int.MaxValue)
            .Select(x =>
            {
                participantsByViewer.TryGetValue(x.ViewerId, out var participant);
                var displayName = string.IsNullOrWhiteSpace(participant?.DisplayNameSnapshot)
                    ? "Viewer"
                    : participant.DisplayNameSnapshot!.Trim();
                return new RoomPresencePlayer(displayName, x.PlayerNumber ?? 0, x.Port);
            })
            .ToList();

        var watcherCount = assignments.Count(x => x.Kind == NosebleedSeatKind.Spectator);
        return new RoomPresenceSnapshot(players, watcherCount, assignments.Count);
    }

    public static RoomChatSnapshot BuildChatSnapshot(IReadOnlyList<GamePlayRoomChatMessage> messages)
    {
        var snapshot = messages
            .OrderBy(x => x.CreatedUtc)
            .Select(x => new RoomChatMessageSnapshot(
                string.IsNullOrWhiteSpace(x.DisplayNameSnapshot) ? "Viewer" : x.DisplayNameSnapshot.Trim(),
                x.Message,
                DateTime.SpecifyKind(x.CreatedUtc, DateTimeKind.Utc)))
            .ToList();

        return new RoomChatSnapshot(snapshot);
    }

    private static string NormalizeChatMessage(string? rawMessage)
    {
        if (string.IsNullOrWhiteSpace(rawMessage))
        {
            return string.Empty;
        }

        return rawMessage
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
    }
}
