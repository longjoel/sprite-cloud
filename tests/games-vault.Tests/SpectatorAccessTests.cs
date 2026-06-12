using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Memory;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using games_vault.Controllers;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using games_vault.Libretro.Import;
using Microsoft.AspNetCore.DataProtection;
using games_vault.Web;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class SpectatorAccessTests : GamesVaultTestBase
{
    [Fact]
    public void Assign_WithAllowPlayerFalse_KeepsViewerAsSpectatorEvenWhenSeatIsOpen()
    {
        var manager = new NosebleedSeatManager(Options.Create(new NosebleedOptions
        {
            MaxPlayersPerSession = 2,
            SeatTtlMinutes = 30
        }));

        var seat = manager.Assign("session-1", "viewer-1", DateTimeOffset.UtcNow, allowPlayer: false);

        Assert.Equal(NosebleedSeatKind.Spectator, seat.Kind);
        Assert.Null(seat.Port);
        Assert.Null(seat.PlayerNumber);
    }

    [Fact]
    public async Task JoinByCodeAsync_ReturnsSpectatorForViewerEvenWhenPlayerSeatIsOpen()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var roomService = fixture.CreateRoomService();

        var result = await roomService.JoinByCodeAsync(fixture.Room.Code, fixture.ViewerId, CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.Seat);
        Assert.Equal(NosebleedSeatKind.Spectator, result.Seat!.Kind);
        Assert.Null(result.Seat.Port);
        Assert.NotNull(result.Room);

        var participant = await fixture.Db.GamePlayRoomParticipants.SingleAsync(x => x.RoomId == fixture.Room.Id && x.ViewerId == fixture.ViewerId);
        Assert.Equal(GamePlayRoomParticipantRole.Spectator, participant.Role);
        Assert.Null(participant.Port);
    }

    [Fact]
    public async Task KeepAliveServerSession_DoesNotPromoteViewerToPlayer()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var controller = fixture.CreateSessionController();

        var result = await controller.KeepAliveServerSession(fixture.Session.Id, CancellationToken.None);

        var json = Assert.IsType<JsonResult>(result);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(json.Value));
        Assert.Equal("spectator", doc.RootElement.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("port").ValueKind);
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("playerNumber").ValueKind);
    }

    [Fact]
    public async Task KeepAliveServerSession_KeepsSignedInPlayerOnStandaloneSession()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        fixture.Db.GamePlayRooms.Remove(fixture.Room);
        await fixture.Db.SaveChangesAsync();

        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");

        var controller = fixture.CreateSessionController();

        var result = await controller.KeepAliveServerSession(fixture.Session.Id, CancellationToken.None);

        var json = Assert.IsType<JsonResult>(result);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(json.Value));
        Assert.Equal("player", doc.RootElement.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Number, doc.RootElement.GetProperty("port").ValueKind);
        Assert.Equal(0, doc.RootElement.GetProperty("port").GetInt32());
        Assert.Equal(1, doc.RootElement.GetProperty("playerNumber").GetInt32());
    }

    [Fact]
    public async Task CreateRoomAsync_ReusesExistingStandaloneRoomForSameProfileAndGame()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;
        await fixture.Db.SaveChangesAsync();

        var roomService = fixture.CreateRoomService();
        var created = await roomService.CreateRoomAsync(
            fixture.Game.Id,
            fixture.File.Id,
            fixture.Game.SystemName,
            fixture.File.ExternalPath!,
            CancellationToken.None);

        Assert.True(created.Success);
        Assert.NotNull(created.Room);
        Assert.Equal(fixture.Room.Id, created.Room!.Id);
        Assert.Equal(fixture.Room.Code, created.Room.Code);
        Assert.Equal(fixture.Session.Id, created.Session!.Id);
        Assert.Equal(1, await fixture.Db.GamePlayRooms.CountAsync());
    }

    [Fact]
    public async Task CreateRoomAsync_ClosesOtherStandaloneRoomsOwnedByProfile()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;

        var otherGame = new Game { Name = "Other Game", SystemName = fixture.Game.SystemName, SizeBytes = 1 };
        var otherFile = new GameFile { Game = otherGame, Name = "other.bin", SizeBytes = 1, ExternalPath = fixture.File.ExternalPath };
        fixture.Db.Games.Add(otherGame);
        fixture.Db.GameFiles.Add(otherFile);
        await fixture.Db.SaveChangesAsync();

        var otherSessionId = "games-vault-other-session";
        var otherRoom = new GamePlayRoom
        {
            Code = "WXYZAB",
            GameId = otherGame.Id,
            GameFileId = otherFile.Id,
            CreatedByProfileId = profile.Id,
            Status = GamePlayRoomStatus.Active,
            CreatedUtc = DateTime.UtcNow,
            LastActiveUtc = DateTime.UtcNow,
            NosebleedSessionId = otherSessionId
        };
        fixture.Db.GamePlayRooms.Add(otherRoom);
        await fixture.Db.SaveChangesAsync();

        SeedSession(fixture.SessionManager, new NosebleedSession(
            otherSessionId,
            otherGame.Id,
            otherFile.Id,
            18124,
            "http://127.0.0.1:18124",
            null,
            null,
            DateTimeOffset.UtcNow,
            "/tmp/fake-core.so",
            fixture.File.ExternalPath!),
            StartLongRunningProcess());

        var roomService = fixture.CreateRoomService();
        var created = await roomService.CreateRoomAsync(
            fixture.Game.Id,
            fixture.File.Id,
            fixture.Game.SystemName,
            fixture.File.ExternalPath!,
            CancellationToken.None);

        Assert.True(created.Success);
        Assert.Equal(fixture.Room.Id, created.Room!.Id);

        fixture.Db.ChangeTracker.Clear();
        var persistedOtherRoom = await fixture.Db.GamePlayRooms.AsNoTracking().SingleAsync(x => x.Id == otherRoom.Id);
        Assert.Equal(GamePlayRoomStatus.Closed, persistedOtherRoom.Status);
        Assert.NotNull(persistedOtherRoom.ClosedUtc);
        Assert.DoesNotContain(fixture.SessionManager.GetSessions(), x => x.SessionId == otherSessionId);
    }

    [Fact]
    public async Task DisconnectRoomParticipantSessionAsync_ClosesStandaloneRoomWhenNoPlayersRemain()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;
        await fixture.Db.SaveChangesAsync();

        var roomService = fixture.CreateRoomService();
        var joined = await roomService.JoinByCodeAsync(fixture.Room.Code, fixture.ViewerId, CancellationToken.None);
        Assert.True(joined.Success);
        Assert.Equal(NosebleedSeatKind.Player, joined.Seat!.Kind);

        fixture.SeatManager.Release(fixture.Session.Id, fixture.ViewerId);
        await roomService.DisconnectRoomParticipantSessionAsync(fixture.Session.Id, fixture.ViewerId, CancellationToken.None);

        fixture.Db.ChangeTracker.Clear();
        var room = await fixture.Db.GamePlayRooms.AsNoTracking().SingleAsync(x => x.Id == fixture.Room.Id);
        Assert.Equal(GamePlayRoomStatus.Closed, room.Status);
        Assert.NotNull(room.ClosedUtc);
        Assert.Empty(fixture.SessionManager.GetSessions());
    }

    [Fact]
    public async Task DisconnectRoomParticipantSessionAsync_RemovesRoomChatWhenStandaloneRoomCloses()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;
        await fixture.Db.SaveChangesAsync();

        fixture.Db.GamePlayRoomChatMessages.Add(new GamePlayRoomChatMessage
        {
            RoomId = fixture.Room.Id,
            ProfileId = profile.Id,
            DisplayNameSnapshot = profile.DisplayName,
            Message = "bye room"
        });
        await fixture.Db.SaveChangesAsync();

        var roomService = fixture.CreateRoomService();
        var joined = await roomService.JoinByCodeAsync(fixture.Room.Code, fixture.ViewerId, CancellationToken.None);
        Assert.True(joined.Success);
        Assert.Equal(NosebleedSeatKind.Player, joined.Seat!.Kind);

        fixture.SeatManager.Release(fixture.Session.Id, fixture.ViewerId);
        await roomService.DisconnectRoomParticipantSessionAsync(fixture.Session.Id, fixture.ViewerId, CancellationToken.None);

        fixture.Db.ChangeTracker.Clear();
        Assert.Empty(await fixture.Db.GamePlayRoomChatMessages.AsNoTracking().Where(x => x.RoomId == fixture.Room.Id).ToListAsync());
    }

    [Fact]
    public async Task PlayServer_Maps_Battery_Save_Diagnostics_Into_The_Player_Model()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var controller = fixture.CreateSessionController();
        controller.ControllerContext.RouteData = new Microsoft.AspNetCore.Routing.RouteData();
        controller.ControllerContext.RouteData.Values["code"] = fixture.Room.Code;
        controller.TempData = new TempDataDictionary(fixture.HttpContextAccessor.HttpContext!, new TestTempDataProvider())
        {
            ["BatterySaveDiagnostics"] = JsonSerializer.Serialize(new[]
            {
                new games_vault.Models.ViewModels.ProfileBatterySaveLogEntry("good", "Runtime restore", "Restored 1 runtime save file.")
            }, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        };

        var result = await controller.PlayServer(fixture.Game.Id, fixture.Room.Code, cancellationToken: CancellationToken.None);

        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<ServerGamePlayViewModel>(view.Model);
        Assert.Single(model.BatterySaveDiagnostics);
        Assert.Equal("Runtime restore", model.BatterySaveDiagnostics[0].Title);
        Assert.Contains("runtime save file", model.BatterySaveDiagnostics[0].Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PlayServer_RedirectsSignedInPlayerToTheirExistingStandaloneRoom()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;
        await fixture.Db.SaveChangesAsync();

        var roomService = fixture.CreateRoomService();
        var joined = await roomService.JoinByCodeAsync(fixture.Room.Code, fixture.ViewerId, CancellationToken.None);
        Assert.True(joined.Success);
        Assert.Equal(NosebleedSeatKind.Player, joined.Seat!.Kind);

        var controller = fixture.CreateSessionController();
        controller.ControllerContext.RouteData = new Microsoft.AspNetCore.Routing.RouteData();
        var result = await controller.PlayServer(fixture.Game.Id, cancellationToken: CancellationToken.None);

        var redirect = Assert.IsType<RedirectToRouteResult>(result);
        Assert.Equal("PlayServerRoom", redirect.RouteName);
        Assert.NotNull(redirect.RouteValues);
        Assert.Equal(fixture.Game.Id, redirect.RouteValues!["id"]);
        Assert.Equal(fixture.Room.Code, redirect.RouteValues["code"]);
    }

    [Fact]
    public async Task PlayServer_WithFreshStandaloneRoomCode_JoinsRoomBeforePlayerlessCleanupRuns()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;
        await fixture.Db.SaveChangesAsync();

        var controller = fixture.CreateSessionController();
        controller.ControllerContext.RouteData = new Microsoft.AspNetCore.Routing.RouteData();
        controller.ControllerContext.RouteData.Values["code"] = fixture.Room.Code;
        var result = await controller.PlayServer(fixture.Game.Id, fixture.Room.Code, cancellationToken: CancellationToken.None);

        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<ServerGamePlayViewModel>(view.Model);
        Assert.Null(model.Error);
        Assert.Equal(fixture.Session.Id, model.SessionId);
        Assert.Equal(1, model.PlayerNumber);
        Assert.False(model.IsSpectator);

        fixture.Db.ChangeTracker.Clear();
        var room = await fixture.Db.GamePlayRooms.AsNoTracking().SingleAsync(x => x.Id == fixture.Room.Id);
        Assert.Equal(GamePlayRoomStatus.Active, room.Status);

        var participant = await fixture.Db.GamePlayRoomParticipants.AsNoTracking().SingleAsync(x => x.RoomId == fixture.Room.Id && x.ViewerId == fixture.ViewerId);
        Assert.Equal(GamePlayRoomParticipantRole.Player, participant.Role);
        Assert.True(participant.IsConnected);
    }

    [Fact]
    public async Task JoinByCodeAsync_RejoiningSameRoomFromNewViewerId_DoesNotConsumeSecondPlayerSeat()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        var localProfiles = new LocalProfileService(fixture.Db, currentProfile);
        var profile = await localProfiles.CreateAsync("Player One", "player-one", "password123", "#198754", CancellationToken.None);
        currentProfile.SetCurrent(profile.Id, "session-nonce-1");
        fixture.Room.CreatedByProfileId = profile.Id;
        await fixture.Db.SaveChangesAsync();

        var roomService = fixture.CreateRoomService();
        var firstJoin = await roomService.JoinByCodeAsync(fixture.Room.Code, fixture.ViewerId, CancellationToken.None);
        Assert.True(firstJoin.Success);
        Assert.Equal(NosebleedSeatKind.Player, firstJoin.Seat!.Kind);
        Assert.Equal(0, firstJoin.Seat.Port);

        var secondViewerId = Guid.NewGuid().ToString("N");
        fixture.HttpContext.Request.Headers.Cookie = $"games_vault_nosebleed_viewer={secondViewerId}";
        var secondJoin = await roomService.JoinByCodeAsync(fixture.Room.Code, secondViewerId, CancellationToken.None);

        Assert.True(secondJoin.Success);
        Assert.Equal(NosebleedSeatKind.Player, secondJoin.Seat!.Kind);
        Assert.Equal(0, secondJoin.Seat.Port);
        Assert.Equal(1, secondJoin.Seat.PlayerNumber);

        var assignments = fixture.SeatManager.GetAssignments(fixture.Session.Id, DateTimeOffset.UtcNow);
        var players = assignments.Where(x => x.Kind == NosebleedSeatKind.Player).ToList();
        Assert.Single(players);
        Assert.Equal(secondViewerId, players[0].ViewerId);
        Assert.Equal(0, players[0].Port);

        fixture.Db.ChangeTracker.Clear();
        var participants = await fixture.Db.GamePlayRoomParticipants
            .AsNoTracking()
            .Where(x => x.RoomId == fixture.Room.Id && x.ProfileId == profile.Id)
            .OrderBy(x => x.ViewerId)
            .ToListAsync();
        Assert.Equal(2, participants.Count);
        Assert.False(participants.Single(x => x.ViewerId == fixture.ViewerId).IsConnected);
        Assert.True(participants.Single(x => x.ViewerId == secondViewerId).IsConnected);
    }

    [Fact]
    public async Task PlayServer_WithMissingRoomCode_RedirectsBackToGamesIndex()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();

        var controller = fixture.CreateSessionController();
        controller.ControllerContext.RouteData = new Microsoft.AspNetCore.Routing.RouteData();
        controller.ControllerContext.RouteData.Values["code"] = "ZZZZ99";
        var result = await controller.PlayServer(fixture.Game.Id, "ZZZZ99", cancellationToken: CancellationToken.None);

        var redirect = Assert.IsType<RedirectToActionResult>(result);
        Assert.Equal(nameof(GamesController.Index), redirect.ActionName);
        Assert.Equal("Session code must be exactly 6 letters.", controller.TempData["Message"]);
    }

    [Fact]
    public async Task JoinByShareTokenAsync_ReturnsPlayerSeatForEphemeralGuestWhenPlayerLinkIsRedeemed()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var localProfiles = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        fixture.Room.CreatedByProfileId = host.Id;
        await fixture.Db.SaveChangesAsync();
        var shareLinks = fixture.CreateShareLinkService();
        var created = await shareLinks.CreateAsync(fixture.Room.Id, host.Id, RoomShareGrantMode.Player, CancellationToken.None);
        fixture.HttpContext.Response.Headers.Clear();

        var roomService = fixture.CreateRoomService();
        var result = await roomService.JoinByShareTokenAsync(created.RawToken, fixture.ViewerId, CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.Seat);
        Assert.Equal(NosebleedSeatKind.Player, result.Seat!.Kind);
        Assert.NotNull(result.Seat.Port);
        var participant = await fixture.Db.GamePlayRoomParticipants.SingleAsync(x => x.RoomId == fixture.Room.Id && x.ViewerId == fixture.ViewerId);
        Assert.Equal(GamePlayRoomParticipantRole.Player, participant.Role);
        Assert.NotNull(participant.ProfileId);

        var guest = await fixture.Db.UserProfiles.SingleAsync(x => x.Id == participant.ProfileId);
        Assert.True(guest.IsEphemeral);
        Assert.Equal(host.Id, guest.ParentProfileId);
    }

    [Fact]
    public async Task CreateRoomAsync_RejectsEphemeralGuestEvenAfterPlayerShareLinkRedemption()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var localProfiles = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        fixture.Room.CreatedByProfileId = host.Id;
        await fixture.Db.SaveChangesAsync();
        var shareLinks = fixture.CreateShareLinkService();
        var created = await shareLinks.CreateAsync(fixture.Room.Id, host.Id, RoomShareGrantMode.Player, CancellationToken.None);
        fixture.HttpContext.Response.Headers.Clear();

        var roomService = fixture.CreateRoomService();
        var redeemed = await roomService.JoinByShareTokenAsync(created.RawToken, fixture.ViewerId, CancellationToken.None);
        Assert.True(redeemed.Success);
        var guest = await fixture.Db.UserProfiles.SingleAsync(x => x.ParentProfileId == host.Id && x.IsEphemeral);
        Assert.Equal(NosebleedSeatKind.Player, redeemed.Seat!.Kind);

        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        currentProfile.SetCurrent(guest.Id, "guest-session");

        var createdRoom = await roomService.CreateRoomAsync(
            fixture.Game.Id,
            fixture.File.Id,
            fixture.Game.SystemName,
            fixture.File.ExternalPath!,
            CancellationToken.None);

        Assert.False(createdRoom.Success);
        Assert.Equal("Sign in with a player profile to create a room.", createdRoom.Error);
    }

    [Fact]
    public async Task JoinByCodeAsync_ReturnsSpectatorForEphemeralGuestOutsideRedeemedRoom()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var localProfiles = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        fixture.Room.CreatedByProfileId = host.Id;
        await fixture.Db.SaveChangesAsync();
        var shareLinks = fixture.CreateShareLinkService();
        var created = await shareLinks.CreateAsync(fixture.Room.Id, host.Id, RoomShareGrantMode.Player, CancellationToken.None);
        fixture.HttpContext.Response.Headers.Clear();

        var roomService = fixture.CreateRoomService();
        var redeemed = await roomService.JoinByShareTokenAsync(created.RawToken, fixture.ViewerId, CancellationToken.None);
        Assert.True(redeemed.Success);
        var guest = await fixture.Db.UserProfiles.SingleAsync(x => x.ParentProfileId == host.Id && x.IsEphemeral);

        var otherGame = new Game { Name = "Other Game", SystemName = fixture.Game.SystemName, SizeBytes = 1 };
        var otherFile = new GameFile { Game = otherGame, Name = "other.bin", SizeBytes = 1, ExternalPath = fixture.File.ExternalPath };
        fixture.Db.Games.Add(otherGame);
        fixture.Db.GameFiles.Add(otherFile);
        await fixture.Db.SaveChangesAsync();
        var otherSessionId = "games-vault-other-share-session";
        var otherRoom = new GamePlayRoom
        {
            Code = "QWERTY",
            GameId = otherGame.Id,
            GameFileId = otherFile.Id,
            CreatedByProfileId = host.Id,
            Status = GamePlayRoomStatus.Active,
            CreatedUtc = DateTime.UtcNow,
            LastActiveUtc = DateTime.UtcNow,
            NosebleedSessionId = otherSessionId
        };
        fixture.Db.GamePlayRooms.Add(otherRoom);
        await fixture.Db.SaveChangesAsync();
        SeedSession(fixture.SessionManager, new NosebleedSession(
            otherSessionId,
            otherGame.Id,
            otherFile.Id,
            18125,
            "http://127.0.0.1:18125",
            null,
            null,
            DateTimeOffset.UtcNow,
            "/tmp/fake-core.so",
            fixture.File.ExternalPath!),
            StartLongRunningProcess());

        var currentProfile = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
        currentProfile.SetCurrent(guest.Id, "guest-session");
        var outsideShareResult = await roomService.JoinByCodeAsync(otherRoom.Code, "other-viewer", CancellationToken.None);

        Assert.True(outsideShareResult.Success);
        Assert.Equal(NosebleedSeatKind.Spectator, outsideShareResult.Seat!.Kind);
        Assert.Null(outsideShareResult.Seat.Port);
    }

    [Fact]
    public async Task PlayServer_ShareLinkGuestShowsChatIdentityLabel()
    {
        await using var fixture = await CreateSpectatorFixtureAsync();
        var localProfiles = new LocalProfileService(fixture.Db, new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor));
        var host = await localProfiles.CreateAsync("Joel", "joel", "password123", "#198754", CancellationToken.None);
        fixture.Room.CreatedByProfileId = host.Id;
        await fixture.Db.SaveChangesAsync();
        var shareLinks = fixture.CreateShareLinkService();
        var created = await shareLinks.CreateAsync(fixture.Room.Id, host.Id, RoomShareGrantMode.Player, CancellationToken.None);
        fixture.HttpContext.Response.Headers.Clear();

        var roomService = fixture.CreateRoomService();
        var joined = await roomService.JoinByShareTokenAsync(created.RawToken, fixture.ViewerId, CancellationToken.None);
        Assert.True(joined.Success);

        var controller = fixture.CreateSessionController();
        controller.ControllerContext.RouteData = new Microsoft.AspNetCore.Routing.RouteData();
        controller.ControllerContext.RouteData.Values["code"] = fixture.Room.Code;

        var result = await controller.PlayServer(fixture.Game.Id, fixture.Room.Code, cancellationToken: CancellationToken.None);

        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<ServerGamePlayViewModel>(view.Model);
        Assert.Equal("Chatting as guest of Joel", model.ChatIdentityLabel);
    }

    private async Task<SpectatorFixture> CreateSpectatorFixtureAsync()
    {
        return await SpectatorFixture.CreateAsync(Db);
    }

    private static Process StartLongRunningProcess()
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "/bin/sh",
                ArgumentList = { "-lc", "sleep 300" },
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
        };

        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start test session process.");
        }

        return process;
    }

    private static void SeedSession(NosebleedSessionManager manager, NosebleedSession session, Process process)
    {
        var field = typeof(NosebleedSessionManager).GetField("_sessions", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Could not find NosebleedSessionManager._sessions field.");
        var dictionary = field.GetValue(manager)
            ?? throw new InvalidOperationException("Could not read NosebleedSessionManager._sessions value.");

        var managedSessionType = typeof(NosebleedSessionManager).GetNestedType("ManagedSession", BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Could not find ManagedSession nested type.");
        var managedSession = Activator.CreateInstance(managedSessionType, session, process)
            ?? throw new InvalidOperationException("Could not construct ManagedSession.");

        var tryAdd = dictionary.GetType().GetMethod("TryAdd")
            ?? throw new InvalidOperationException("Could not find ConcurrentDictionary.TryAdd.");
        var added = (bool)(tryAdd.Invoke(dictionary, new object[] { session.Id, managedSession }) ?? false);
        if (!added)
        {
            throw new InvalidOperationException("Failed to seed active Nosebleed session into manager.");
        }
    }

    private sealed class SpectatorFixture : IAsyncDisposable
    {
        private readonly Process _sessionProcess;
        private readonly IHttpContextAccessor _httpContextAccessor;
        private readonly IConfiguration _configuration;
        private readonly IOptions<NosebleedOptions> _nosebleedOptions;
        private readonly NosebleedTicketSigner _ticketSigner;

        private SpectatorFixture(
            AppDbContext db,
            Game game,
            GameFile file,
            GamePlayRoom room,
            NosebleedSession session,
            Process sessionProcess,
            string viewerId,
            IHttpContextAccessor httpContextAccessor,
            IConfiguration configuration,
            IOptions<NosebleedOptions> nosebleedOptions,
            NosebleedTicketSigner ticketSigner,
            NosebleedSessionManager sessionManager,
            NosebleedSeatManager seatManager)
        {
            Db = db;
            Game = game;
            File = file;
            Room = room;
            Session = session;
            _sessionProcess = sessionProcess;
            ViewerId = viewerId;
            _httpContextAccessor = httpContextAccessor;
            _configuration = configuration;
            _nosebleedOptions = nosebleedOptions;
            _ticketSigner = ticketSigner;
            SessionManager = sessionManager;
            SeatManager = seatManager;
        }

        public AppDbContext Db { get; }
        public Game Game { get; }
        public GameFile File { get; }
        public GamePlayRoom Room { get; }
        public NosebleedSession Session { get; }
        public string ViewerId { get; }
        public NosebleedSessionManager SessionManager { get; }
        public NosebleedSeatManager SeatManager { get; }
        public DefaultHttpContext HttpContext => (DefaultHttpContext)_httpContextAccessor.HttpContext!;
        public IHttpContextAccessor HttpContextAccessor => _httpContextAccessor;

        public static async Task<SpectatorFixture> CreateAsync(AppDbContext db)
        {
            var tempRoot = Path.Combine(Path.GetTempPath(), "games-vault-spectator-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            var romPath = Path.Combine(tempRoot, "viewer-test.bin");
            await System.IO.File.WriteAllTextAsync(romPath, "fake-rom");

            var game = new Game { Name = "Viewer Test Game", SystemName = "Sega - Mega Drive - Genesis", SizeBytes = 1 };
            var file = new GameFile { Game = game, Name = "viewer-test.bin", SizeBytes = 1, ExternalPath = romPath };
            db.Games.Add(game);
            db.GameFiles.Add(file);
            db.LocalFolders.Add(new LocalFolder
            {
                Name = "Viewer Test ROM Root",
                RootPath = tempRoot,
                Enabled = true
            });
            await db.SaveChangesAsync();

            var room = new GamePlayRoom
            {
                Code = "ABCDEF",
                GameId = game.Id,
                GameFileId = file.Id,
                Status = GamePlayRoomStatus.Active,
                CreatedUtc = DateTime.UtcNow,
                LastActiveUtc = DateTime.UtcNow,
                NosebleedSessionId = "games-vault-test-session"
            };
            db.GamePlayRooms.Add(room);
            await db.SaveChangesAsync();

            var httpContext = new DefaultHttpContext();
            var viewerId = Guid.NewGuid().ToString("N");
            httpContext.Request.Headers.Cookie = $"games_vault_nosebleed_viewer={viewerId}";
            var accessor = new TestHttpContextAccessor(httpContext);
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Access:AdminAlways"] = "false"
                })
                .Build();

            var secretPath = Path.Combine(Path.GetTempPath(), $"nosebleed-test-{Guid.NewGuid():N}.secret");
            var nosebleedOptions = Options.Create(new NosebleedOptions
            {
                Enabled = true,
                RequireAuth = true,
                AuthSecretPath = secretPath,
                MaxPlayersPerSession = 2,
                SeatTtlMinutes = 30
            });
            var ticketSigner = new NosebleedTicketSigner(nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance);
            var processInspector = new NosebleedProcessInspector(nosebleedOptions);
            var seatManager = new NosebleedSeatManager(nosebleedOptions);
            var sessionManager = new NosebleedSessionManager(
                nosebleedOptions,
                new TestServiceScopeFactory(),
                ticketSigner,
                new TestHttpClientFactory(),
                new SystemCoreMappingResolver(nosebleedOptions),
                processInspector,
                seatManager,
                NullLogger<NosebleedSessionManager>.Instance);

            var process = StartLongRunningProcess();
            var session = new NosebleedSession(
                room.NosebleedSessionId!,
                game.Id,
                file.Id,
                18123,
                "http://127.0.0.1:18123",
                null,
                null,
                DateTimeOffset.UtcNow,
                "/tmp/fake-core.so",
                "/tmp/fake-content.rom");
            SeedSession(sessionManager, session, process);

            var fixture = new SpectatorFixture(
                db,
                game,
                file,
                room,
                session,
                process,
                viewerId,
                accessor,
                configuration,
                nosebleedOptions,
                ticketSigner,
                sessionManager,
                seatManager);

            return fixture;
        }

        public GamePlayRoomService CreateRoomService()
        {
            var currentProfile = new CurrentProfileService(Db, _httpContextAccessor);
            var currentAccess = new CurrentAccessService(currentProfile, _configuration, _httpContextAccessor, Db, new EphemeralDataProtectionProvider(), NullLogger<CurrentAccessService>.Instance);
            return new GamePlayRoomService(
                Db,
                new RoomCodeGenerator(),
                SessionManager,
                SeatManager,
                _ticketSigner,
                currentAccess,
                currentProfile,
                CreateShareLinkService());
        }

        public ProfileShareLinkService CreateShareLinkService()
        {
            var currentProfile = new CurrentProfileService(Db, _httpContextAccessor);
            var localProfiles = new LocalProfileService(Db, currentProfile);
            return new ProfileShareLinkService(Db, localProfiles, new MemoryCache(new MemoryCacheOptions()));
        }

        public SessionController CreateSessionController()
        {
            var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
            services.AddSingleton(Db);
            services.AddSingleton(_nosebleedOptions);
            services.AddSingleton(SessionManager);
            services.AddSingleton(SeatManager);
            services.AddSingleton(_ticketSigner);
            services.AddSingleton<GamePlayRoomService>(_ => CreateRoomService());
            services.AddSingleton<ProfileShareLinkService>(_ => CreateShareLinkService());
            services.AddSingleton<CurrentProfileService>(_ => new CurrentProfileService(Db, _httpContextAccessor));
            services.AddSingleton<ILogger<CurrentAccessService>>(NullLogger<CurrentAccessService>.Instance);
            services.AddSingleton(_configuration);
            services.AddSingleton(_httpContextAccessor);
            services.AddSingleton<Microsoft.AspNetCore.DataProtection.IDataProtectionProvider>(new EphemeralDataProtectionProvider());
            services.AddSingleton<Microsoft.AspNetCore.Mvc.Routing.IUrlHelperFactory>(new Microsoft.AspNetCore.Mvc.Routing.UrlHelperFactory());
            services.AddSingleton<CurrentAccessService>(sp =>
            {
                var cp = sp.GetRequiredService<CurrentProfileService>();
                var cfg = sp.GetRequiredService<Microsoft.Extensions.Configuration.IConfiguration>();
                var acc = sp.GetRequiredService<IHttpContextAccessor>();
                var dp = sp.GetRequiredService<Microsoft.AspNetCore.DataProtection.IDataProtectionProvider>();
                var log = sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<CurrentAccessService>>();
                return new CurrentAccessService(cp, cfg, acc, Db, dp, log);
            });
            services.AddSingleton<GamePlayTelemetryService>(_ => new GamePlayTelemetryService(Db));
            services.AddSingleton<ITurnCredentialService>(new TurnCredentialService(_nosebleedOptions));
            // GameFileStorage needs an IWebHostEnvironment.
            services.AddSingleton<GameFileStorage>(_ =>
            {
                var fakeEnv = new FakeEnvironment(System.IO.Path.GetTempPath());
                return new GameFileStorage(fakeEnv, Microsoft.Extensions.Options.Options.Create(
                    new games_vault.Libretro.Import.LibraryStorageOptions { RootPath = System.IO.Path.GetTempPath() }));
            });
            var serviceProvider = services.BuildServiceProvider();

            var httpContext = _httpContextAccessor.HttpContext!;
            httpContext.RequestServices = serviceProvider;

            var controller = new SessionController(Db)
            {
                ControllerContext = new ControllerContext { HttpContext = httpContext },
                TempData = new TempDataDictionary(httpContext, new TestTempDataProvider())
            };

            return controller;
        }

        public async ValueTask DisposeAsync()
        {
            SessionManager.Dispose();
            try
            {
                if (!_sessionProcess.HasExited)
                {
                    _sessionProcess.Kill(entireProcessTree: true);
                    await _sessionProcess.WaitForExitAsync();
                }
            }
            catch (InvalidOperationException)
            {
                // SessionManager.Dispose() already tore down the seeded process.
            }

            // Connection and Db are owned by GamesVaultTestBase — don't dispose them here.
        }

        private static Process StartLongRunningProcess()
        {
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "/bin/sh",
                    ArgumentList = { "-lc", "sleep 300" },
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }
            };

            if (!process.Start())
            {
                throw new InvalidOperationException("Failed to start test session process.");
            }

            return process;
        }

        private static void SeedSession(NosebleedSessionManager manager, NosebleedSession session, Process process)
        {
            var field = typeof(NosebleedSessionManager).GetField("_sessions", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("Could not find NosebleedSessionManager._sessions field.");
            var dictionary = field.GetValue(manager)
                ?? throw new InvalidOperationException("Could not read NosebleedSessionManager._sessions value.");

            var managedSessionType = typeof(NosebleedSessionManager).GetNestedType("ManagedSession", BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("Could not find ManagedSession nested type.");
            var managedSession = Activator.CreateInstance(managedSessionType, session, process)
                ?? throw new InvalidOperationException("Could not construct ManagedSession.");

            var tryAdd = dictionary.GetType().GetMethod("TryAdd")
                ?? throw new InvalidOperationException("Could not find ConcurrentDictionary.TryAdd.");
            var added = (bool)(tryAdd.Invoke(dictionary, new object[] { session.Id, managedSession }) ?? false);
            if (!added)
            {
                throw new InvalidOperationException("Failed to seed active Nosebleed session into manager.");
            }
        }
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed class FakeEnvironment(string contentRootPath) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "games-vault.Tests";
        public string WebRootPath { get; set; } = contentRootPath;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = contentRootPath;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private sealed class TestServiceScopeFactory : IServiceScopeFactory
    {
        public IServiceScope CreateScope() => new TestServiceScope();
    }

    private sealed class TestServiceScope : IServiceScope
    {
        public IServiceProvider ServiceProvider { get; } = new Microsoft.Extensions.DependencyInjection.ServiceCollection().BuildServiceProvider();

        public void Dispose()
        {
        }
    }

    private sealed class TestTempDataProvider : ITempDataProvider
    {
        public IDictionary<string, object> LoadTempData(HttpContext context) => new Dictionary<string, object>();

        public void SaveTempData(HttpContext context, IDictionary<string, object> values)
        {
        }
    }
}
