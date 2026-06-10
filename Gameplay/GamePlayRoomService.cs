using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
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
    CurrentProfileService currentProfile,
    ProfileShareLinkService shareLinks,
    BatterySavePolicyResolver? batterySavePolicyResolver = null,
    BatterySaveRuntimeSyncService? batterySaveRuntimeSyncService = null)
{
    public async Task<RoomCreateResult> CreateRoomAsync(int gameId, int gameFileId, string systemName, string contentPath, CancellationToken ct)
    {
        if (!await currentAccess.CanPlayAsync(ct))
        {
            return RoomCreateResult.Fail("Sign in with a player profile to create a room.");
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        if (profile?.Id is int profileId)
        {
            var reusableRoom = await FindReusableStandaloneRoomAsync(gameId, profileId, ct);
            if (reusableRoom is not null)
            {
                var reusableSession = nosebleedSessions.GetSessions()
                    .FirstOrDefault(x => string.Equals(x.SessionId, reusableRoom.NosebleedSessionId, StringComparison.OrdinalIgnoreCase) && !x.HasExited);
                if (reusableSession is not null)
                {
                    var session = new NosebleedSession(
                        reusableSession.SessionId,
                        reusableSession.GameId,
                        reusableSession.FileId,
                        reusableSession.Port,
                        reusableSession.BaseUrl,
                        null,
                        reusableSession.StartedUtc,
                        reusableSession.CorePath,
                        reusableSession.ContentPath);

                    return RoomCreateResult.Ok(reusableRoom, session);
                }
            }
        }

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

        var diagnostics = new List<ProfileBatterySaveLogEntry>();
        var batterySavePolicy = (batterySavePolicyResolver ?? new BatterySavePolicyResolver()).Resolve(room, profile);
        var sessionId = nosebleedSessions.CreateSessionId(gameId, gameFileId);
        string? runtimeSaveDir = null;
        if (batterySaveRuntimeSyncService is not null)
        {
            runtimeSaveDir = batterySaveRuntimeSyncService.GetRuntimeSaveDirectory(sessionId);
            var restoredCount = await batterySaveRuntimeSyncService.PrepareRuntimeSaveDirectoryAsync(
                batterySavePolicy,
                gameId,
                gameFileId,
                systemName,
                sessionId,
                contentPath,
                ct);

            diagnostics.Add(new ProfileBatterySaveLogEntry("good", "Battery saves", $"Prepared runtime save directory for session {sessionId}."));
            if (batterySavePolicy.Mode != BatterySavePersistenceMode.PerProfile || batterySavePolicy.ProfileId is null)
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("warn", "Runtime restore", $"Battery saves are disabled for session {sessionId}; no runtime restore was attempted."));
            }
            else if (restoredCount > 0)
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("good", "Runtime restore", $"Restored {restoredCount} runtime save file(s) for profile {batterySavePolicy.ProfileId} into {batterySaveRuntimeSyncService.GetRuntimeSaveDirectory(sessionId)}."));
            }
            else
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("warn", "Runtime restore", $"No runtime save files were restored for profile {batterySavePolicy.ProfileId} into {batterySaveRuntimeSyncService.GetRuntimeSaveDirectory(sessionId)}."));
            }
        }

        using var tx = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var start = await nosebleedSessions.StartOrReuseAsync(
                gameId,
                gameFileId,
                systemName,
                contentPath,
                ct,
                $"room:{room.Id}",
                sessionId);

            if (!start.Success || start.Session is null)
            {
                room.Status = GamePlayRoomStatus.Closed;
                room.ClosedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                // Clean up the runtime save directory that was prepared
                // before the start attempt — no session to use it.
                if (runtimeSaveDir is not null && Directory.Exists(runtimeSaveDir))
                {
                    try { Directory.Delete(runtimeSaveDir, recursive: true); }
                    catch { /* best-effort cleanup */ }
                }
                return RoomCreateResult.Fail(start.Error ?? "Failed to start room session.");
            }

            room.NosebleedSessionId = start.Session.Id;
            room.LastActiveUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);

            return RoomCreateResult.Ok(room, start.Session, diagnostics);
        }
        catch
        {
            await tx.RollbackAsync(CancellationToken.None);
            if (runtimeSaveDir is not null && Directory.Exists(runtimeSaveDir))
            {
                try { Directory.Delete(runtimeSaveDir, recursive: true); }
                catch { /* best-effort cleanup */ }
            }
            throw;
        }
    }

    public async Task<RoomJoinResult> JoinByCodeAsync(string rawCode, string viewerId, CancellationToken ct)
    {
        var code = NormalizeCode(rawCode);
        if (code is null)
        {
            return RoomJoinResult.Fail("Session code must be exactly 6 letters.");
        }

        var room = await db.GamePlayRooms
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .Include(x => x.ArcadeCabinet)
                .ThenInclude(x => x!.Arcade)
            .FirstOrDefaultAsync(x => x.Code == code && x.Status == GamePlayRoomStatus.Active, ct);

        if (room is null)
        {
            return RoomJoinResult.Fail("No active room found for that code.");
        }

        var isFreePlayArcade = room.ArcadeCabinet is not null
            && room.ArcadeCabinet.CreditMode == ArcadeCabinetCreditMode.FreePlay
            && room.ArcadeCabinet.IsEnabled
            && room.ArcadeCabinet.Arcade.IsEnabled;
        return await JoinRoomAsync(room, viewerId, ct, allowPlayerOverride: isFreePlayArcade ? true : null);
    }

    public async Task<RoomJoinResult> JoinByShareTokenAsync(string rawToken, string viewerId, CancellationToken ct)
    {
        var redeemed = await shareLinks.RedeemAsync(rawToken, ct);
        var room = await db.GamePlayRooms
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .FirstOrDefaultAsync(x => x.Id == redeemed.ShareLink.RoomId && x.Status == GamePlayRoomStatus.Active, ct);

        if (room is null)
        {
            return RoomJoinResult.Fail("That room is no longer active.");
        }

        return await JoinRoomAsync(room, viewerId, ct, allowPlayerOverride: redeemed.ShareLink.GrantMode == RoomShareGrantMode.Player);
    }

    public async Task<RoomJoinResult> JoinByShareTokenAsync(ProfileShareLink shareLink, UserProfile guest, string viewerId, CancellationToken ct)
    {
        var room = await db.GamePlayRooms
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .FirstOrDefaultAsync(x => x.Id == shareLink.RoomId && x.Status == GamePlayRoomStatus.Active, ct);

        if (room is null)
        {
            return RoomJoinResult.Fail("That room is no longer active.");
        }

        return await JoinRoomAsync(room, viewerId, ct, allowPlayerOverride: shareLink.GrantMode == RoomShareGrantMode.Player);
    }

    public async Task<RoomJoinResult> JoinArcadeCabinetAsync(ArcadeCabinet cabinet, NosebleedSession session, string viewerId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(cabinet);
        ArgumentNullException.ThrowIfNull(session);

        var room = await db.GamePlayRooms
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .Where(x => x.ArcadeCabinetId == cabinet.Id)
            .OrderBy(x => x.CreatedUtc)
            .ThenBy(x => x.Id)
            .FirstOrDefaultAsync(ct);

        var gameFileId = cabinet.GameFileId ?? session.FileId;

        var duplicateRooms = room is null
            ? []
            : await db.GamePlayRooms
                .Where(x => x.ArcadeCabinetId == cabinet.Id && x.Id != room.Id && x.Status == GamePlayRoomStatus.Active)
                .ToListAsync(ct);

        if (room is null)
        {
            var profile = await currentProfile.GetCurrentAsync(ct);
            room = new GamePlayRoom
            {
                Code = await GenerateUniqueCodeAsync(ct),
                GameId = cabinet.GameId,
                GameFileId = gameFileId,
                CreatedByProfileId = profile?.Id,
                Status = GamePlayRoomStatus.Active,
                CreatedUtc = DateTime.UtcNow,
                LastActiveUtc = DateTime.UtcNow,
                IsArcadeBound = true,
                ArcadeCabinetId = cabinet.Id,
                NosebleedSessionId = session.Id
            };

            db.GamePlayRooms.Add(room);
            await db.SaveChangesAsync(ct);

            room.Game = cabinet.Game;
            if (cabinet.GameFile is not null)
            {
                room.GameFile = cabinet.GameFile;
            }
        }
        else
        {
            room.GameId = cabinet.GameId;
            room.GameFileId = gameFileId;
            room.IsArcadeBound = true;
            room.ArcadeCabinetId = cabinet.Id;
            room.Status = GamePlayRoomStatus.Active;
            room.ClosedUtc = null;
            room.NosebleedSessionId = session.Id;
            room.LastActiveUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        if (duplicateRooms.Count > 0)
        {
            foreach (var duplicateRoom in duplicateRooms)
            {
                duplicateRoom.Status = GamePlayRoomStatus.Closed;
                duplicateRoom.ClosedUtc = DateTime.UtcNow;
            }

            await db.SaveChangesAsync(ct);
        }

        var isFreePlay = cabinet.CreditMode == ArcadeCabinetCreditMode.FreePlay;
        return await JoinRoomAsync(room, viewerId, ct, allowPlayerOverride: isFreePlay ? true : null);
    }

    public async Task TouchRoomParticipantSessionAsync(int roomId, string viewerId, NosebleedSeatAssignment seat, CancellationToken ct)
    {
        var participant = await db.GamePlayRoomParticipants.FirstOrDefaultAsync(x => x.RoomId == roomId && x.ViewerId == viewerId, ct);
        if (participant is null)
        {
            return;
        }

        participant.Role = seat.Kind == NosebleedSeatKind.Player ? GamePlayRoomParticipantRole.Player : GamePlayRoomParticipantRole.Spectator;
        participant.Port = seat.Port;
        participant.IsConnected = true;
        participant.LastSeenUtc = DateTime.UtcNow;

        var room = await db.GamePlayRooms.FirstOrDefaultAsync(x => x.Id == roomId, ct);
        if (room is not null)
        {
            room.LastActiveUtc = DateTime.UtcNow;
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task DisconnectRoomParticipantSessionAsync(string sessionId, string viewerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(viewerId))
        {
            return;
        }

        var room = await db.GamePlayRooms.FirstOrDefaultAsync(
            x => x.NosebleedSessionId == sessionId && x.Status == GamePlayRoomStatus.Active,
            ct);
        if (room is null)
        {
            return;
        }

        var participant = await db.GamePlayRoomParticipants.FirstOrDefaultAsync(x => x.RoomId == room.Id && x.ViewerId == viewerId, ct);
        if (participant is null)
        {
            return;
        }

        participant.IsConnected = false;
        participant.LastSeenUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        await CleanupStandaloneRoomIfNoPlayersRemainAsync(room, ct, $"viewer-left:{viewerId}");
    }

    public async Task<RoomBatterySaveFlushResult> FlushStandaloneRoomBatterySaveAsync(int roomId, CancellationToken ct)
    {
        if (!await currentAccess.CanPlayRoomAsync(roomId, ct))
        {
            return RoomBatterySaveFlushResult.Fail("Sign in with a player profile to flush saves for this room.");
        }

        var room = await db.GamePlayRooms
            .Include(x => x.Game)
            .FirstOrDefaultAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, ct);
        if (room is null)
        {
            return RoomBatterySaveFlushResult.Fail("That room is no longer active.");
        }

        if (room.IsArcadeBound)
        {
            return RoomBatterySaveFlushResult.Fail("Arcade rooms do not use durable battery saves.");
        }

        if (batterySaveRuntimeSyncService is null)
        {
            return RoomBatterySaveFlushResult.Fail("Battery save runtime sync is not available.");
        }

        if (string.IsNullOrWhiteSpace(room.NosebleedSessionId))
        {
            return RoomBatterySaveFlushResult.Fail("That room does not have a live runtime session.");
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        var batterySavePolicy = (batterySavePolicyResolver ?? new BatterySavePolicyResolver()).Resolve(room, profile);
        var capturedCount = await batterySaveRuntimeSyncService.CaptureRuntimeSaveRevisionsAsync(
            batterySavePolicy,
            room.GameId,
            room.GameFileId,
            room.Game?.SystemName ?? await db.Games.Where(x => x.Id == room.GameId).Select(x => x.SystemName).FirstAsync(ct),
            room.NosebleedSessionId,
            ct);

        if (capturedCount <= 0)
        {
            return RoomBatterySaveFlushResult.Ok(0, "No runtime save files were found to flush.");
        }

        return RoomBatterySaveFlushResult.Ok(capturedCount, $"Flushed {capturedCount} runtime save file(s).");
    }

    public async Task<RoomPlayerKickResult> KickRoomPlayerAsync(int roomId, string requesterViewerId, string targetViewerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(requesterViewerId) || string.IsNullOrWhiteSpace(targetViewerId))
        {
            return RoomPlayerKickResult.Fail("A player identity is required to kick a player.");
        }

        if (string.Equals(requesterViewerId, targetViewerId, StringComparison.Ordinal))
        {
            return RoomPlayerKickResult.Fail("You cannot kick yourself.");
        }

        var room = await db.GamePlayRooms.FirstOrDefaultAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, ct);
        if (room is null || string.IsNullOrWhiteSpace(room.NosebleedSessionId))
        {
            return RoomPlayerKickResult.Fail("That room is no longer active.");
        }

        var assignments = nosebleedSeats.GetAssignments(room.NosebleedSessionId, DateTimeOffset.UtcNow);
        var requester = assignments.FirstOrDefault(x => string.Equals(x.ViewerId, requesterViewerId, StringComparison.Ordinal));
        var target = assignments.FirstOrDefault(x => string.Equals(x.ViewerId, targetViewerId, StringComparison.Ordinal));
        var profile = await currentProfile.GetCurrentAsync(ct);
        var requesterCanKick = profile?.IsAdmin == true || requester is { Kind: NosebleedSeatKind.Player, Port: 0 };
        if (!requesterCanKick)
        {
            return RoomPlayerKickResult.Fail("Only Player 1 can kick other players.");
        }

        if (target is null)
        {
            return RoomPlayerKickResult.Fail("That player is no longer connected.");
        }

        if (target.Kind != NosebleedSeatKind.Player)
        {
            return RoomPlayerKickResult.Fail("Only active players can be kicked from a seat.");
        }

        nosebleedSeats.Kick(room.NosebleedSessionId, targetViewerId);
        var participant = await db.GamePlayRoomParticipants.FirstOrDefaultAsync(x => x.RoomId == room.Id && x.ViewerId == targetViewerId, ct);
        if (participant is not null)
        {
            participant.IsConnected = false;
            participant.LastSeenUtc = DateTime.UtcNow;
            participant.Port = null;
            participant.Role = GamePlayRoomParticipantRole.Spectator;
        }

        room.LastActiveUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return RoomPlayerKickResult.Ok();
    }

    private async Task<RoomJoinResult> JoinRoomAsync(GamePlayRoom room, string viewerId, CancellationToken ct, bool? allowPlayerOverride)
    {
        nosebleedSessions.Cleanup();
        var session = nosebleedSessions.GetSessions().FirstOrDefault(x => x.SessionId == room.NosebleedSessionId && !x.HasExited);
        if (session is null)
        {
            if (room.ArcadeCabinetId is not null)
            {
                return RoomJoinResult.Fail("That arcade room is waking back up. Try the room again in a moment.");
            }

            room.Status = GamePlayRoomStatus.Closed;
            room.ClosedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return RoomJoinResult.Fail("That room is no longer active.");
        }

        var now = DateTimeOffset.UtcNow;
        var canPlay = allowPlayerOverride ?? await currentAccess.CanPlayRoomAsync(room.Id, ct);
        var profile = await currentProfile.GetCurrentAsync(ct);
        if (profile?.Id is int profileId)
        {
            await ReleaseOtherProfileSeatsAsync(room, session.SessionId, viewerId, profileId, ct);
        }

        var seat = nosebleedSeats.Assign(session.SessionId, viewerId, now, allowPlayer: canPlay);
        await UpsertParticipantAsync(room, viewerId, profile, seat, ct);

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

    private async Task<GamePlayRoom?> FindReusableStandaloneRoomAsync(int gameId, int profileId, CancellationToken ct)
    {
        nosebleedSessions.Cleanup();

        var existingRooms = await db.GamePlayRooms
            .Where(x => x.CreatedByProfileId == profileId &&
                        x.Status == GamePlayRoomStatus.Active &&
                        !x.IsArcadeBound)
            .OrderByDescending(x => x.LastActiveUtc)
            .ThenByDescending(x => x.CreatedUtc)
            .ToListAsync(ct);

        if (existingRooms.Count == 0)
        {
            return null;
        }

        GamePlayRoom? reusableRoom = null;
        foreach (var existingRoom in existingRooms)
        {
            var hasLiveSession = !string.IsNullOrWhiteSpace(existingRoom.NosebleedSessionId) &&
                nosebleedSessions.GetSessions().Any(x => string.Equals(x.SessionId, existingRoom.NosebleedSessionId, StringComparison.OrdinalIgnoreCase) && !x.HasExited);
            var isSameGame = existingRoom.GameId == gameId;

            if (hasLiveSession && isSameGame && reusableRoom is null)
            {
                reusableRoom = existingRoom;
                continue;
            }

            await CloseStandaloneRoomAsync(existingRoom, ct, hasLiveSession ? "single-room-policy" : "stale-room-policy", stopSession: hasLiveSession);
        }

        return reusableRoom;
    }

    private async Task CleanupStandaloneRoomsWithoutPlayersAsync(CancellationToken ct)
    {
        nosebleedSessions.Cleanup();

        var rooms = await db.GamePlayRooms
            .Where(x => x.Status == GamePlayRoomStatus.Active &&
                        !x.IsArcadeBound &&
                        x.NosebleedSessionId != null)
            .ToListAsync(ct);

        foreach (var room in rooms)
        {
            await CleanupStandaloneRoomIfNoPlayersRemainAsync(room, ct, "playerless-cleanup");
        }
    }

    private async Task CleanupStandaloneRoomIfNoPlayersRemainAsync(GamePlayRoom room, CancellationToken ct, string reason)
    {
        if (room.Status != GamePlayRoomStatus.Active || room.IsArcadeBound || string.IsNullOrWhiteSpace(room.NosebleedSessionId))
        {
            return;
        }

        var sessionId = room.NosebleedSessionId;
        var activePlayers = nosebleedSeats.GetAssignments(sessionId, DateTimeOffset.UtcNow)
            .Any(x => x.Kind == NosebleedSeatKind.Player);
        var managedSessionExists = nosebleedSessions.GetSessions()
            .Any(x => string.Equals(x.SessionId, sessionId, StringComparison.OrdinalIgnoreCase) && !x.HasExited);

        if (managedSessionExists && activePlayers)
        {
            return;
        }

        await CloseStandaloneRoomAsync(room, ct, reason, stopSession: managedSessionExists);
    }

    private async Task CloseStandaloneRoomAsync(GamePlayRoom room, CancellationToken ct, string reason, bool stopSession)
    {
        if (room.Status != GamePlayRoomStatus.Active || room.IsArcadeBound)
        {
            return;
        }

        room.Status = GamePlayRoomStatus.Closed;
        room.ClosedUtc = DateTime.UtcNow;
        room.LastActiveUtc = DateTime.UtcNow;

        var participants = await db.GamePlayRoomParticipants
            .Where(x => x.RoomId == room.Id && x.IsConnected)
            .ToListAsync(ct);
        foreach (var participant in participants)
        {
            participant.IsConnected = false;
            participant.LastSeenUtc = DateTime.UtcNow;
        }

        var chatMessages = await db.GamePlayRoomChatMessages
            .Where(x => x.RoomId == room.Id)
            .ToListAsync(ct);
        if (chatMessages.Count > 0)
        {
            db.GamePlayRoomChatMessages.RemoveRange(chatMessages);
        }

        await db.SaveChangesAsync(ct);

        if (stopSession && !string.IsNullOrWhiteSpace(room.NosebleedSessionId))
        {
            if (batterySaveRuntimeSyncService is not null)
            {
                var batterySavePolicy = await ResolveBatterySavePolicyForRoomAsync(room, ct);

                await batterySaveRuntimeSyncService.CaptureRuntimeSaveRevisionsAsync(
                    batterySavePolicy,
                    room.GameId,
                    room.GameFileId,
                    room.Game?.SystemName ?? await db.Games.Where(x => x.Id == room.GameId).Select(x => x.SystemName).FirstAsync(ct),
                    room.NosebleedSessionId,
                    ct);
            }

            nosebleedSessions.TryStop(room.NosebleedSessionId, reason);
        }
    }

    private async Task<BatterySavePolicy> ResolveBatterySavePolicyForRoomAsync(GamePlayRoom room, CancellationToken ct)
    {
        var resolver = batterySavePolicyResolver ?? new BatterySavePolicyResolver();

        var current = await currentProfile.GetCurrentAsync(ct);
        if (current is not null)
        {
            return resolver.Resolve(room, current);
        }

        var participantProfileId = await db.GamePlayRoomParticipants
            .AsNoTracking()
            .Where(x => x.RoomId == room.Id && x.IsConnected && x.Role == GamePlayRoomParticipantRole.Player && x.ProfileId != null)
            .OrderByDescending(x => x.LastSeenUtc)
            .Select(x => x.ProfileId!.Value)
            .FirstOrDefaultAsync(ct);

        if (participantProfileId > 0)
        {
            var participantProfile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == participantProfileId, ct);
            if (participantProfile is not null)
            {
                return resolver.Resolve(room, participantProfile);
            }
        }

        if (room.CreatedByProfileId is int creatorProfileId)
        {
            var creatorProfile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == creatorProfileId, ct);
            if (creatorProfile is not null)
            {
                return resolver.Resolve(room, creatorProfile);
            }
        }

        return BatterySavePolicy.None();
    }

    public static string? NormalizeCode(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return null;
        }

        var normalized = new string(code.Trim().ToUpperInvariant().Where(c => c >= 'A' && c <= 'Z').ToArray());
        return normalized.Length == 6 ? normalized : null;
    }

    public async Task<RoomChatPostResult> AddChatMessageAsync(int roomId, string? rawMessage, CancellationToken ct)
    {
        if (!await currentAccess.CanChatAsync(ct))
        {
            return RoomChatPostResult.Fail("Sign in with a profile to chat.");
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
            return RoomChatPostResult.Fail("Sign in with a profile to chat.");
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
                return new RoomPresencePlayer(displayName, x.PlayerNumber ?? 0, x.Port, x.ViewerId);
            })
            .ToList();

        var watcherNames = assignments
            .Where(x => x.Kind == NosebleedSeatKind.Spectator)
            .Select(x =>
            {
                participantsByViewer.TryGetValue(x.ViewerId, out var participant);
                return string.IsNullOrWhiteSpace(participant?.DisplayNameSnapshot)
                    ? "Viewer"
                    : participant.DisplayNameSnapshot!.Trim();
            })
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .Select(x => new RoomPresenceWatcher(x))
            .ToList();

        return new RoomPresenceSnapshot(players, watcherNames, watcherNames.Count, assignments.Count);
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

    private async Task ReleaseOtherProfileSeatsAsync(
        GamePlayRoom room,
        string sessionId,
        string viewerId,
        int profileId,
        CancellationToken ct)
    {
        var duplicates = await db.GamePlayRoomParticipants
            .Where(x => x.RoomId == room.Id && x.ProfileId == profileId && x.ViewerId != viewerId && x.IsConnected)
            .ToListAsync(ct);
        if (duplicates.Count == 0)
        {
            return;
        }

        var now = DateTime.UtcNow;
        foreach (var participant in duplicates)
        {
            nosebleedSeats.Release(sessionId, participant.ViewerId);
            participant.IsConnected = false;
            participant.LastSeenUtc = now;
            participant.Port = null;
            participant.Role = GamePlayRoomParticipantRole.Spectator;
        }

        await db.SaveChangesAsync(ct);
    }

    private async Task UpsertParticipantAsync(
        GamePlayRoom room,
        string viewerId,
        UserProfile? profile,
        NosebleedSeatAssignment seat,
        CancellationToken ct)
    {
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
    }
}
