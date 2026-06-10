using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Web;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

[ServiceFilter(typeof(AdminOnlyFilter))]
public sealed class AdminController(
    AppDbContext db,
    NosebleedSessionManager nosebleedSessions,
    NosebleedProcessInspector nosebleedProcessInspector,
    NosebleedStreamSettingsStore streamSettingsStore,
    LibretroDatabaseStore libretroStore,
    SystemDatIndexProvider systemDat,
    SystemFileStorage systemFileStorage) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        nosebleedSessions.Cleanup();
        var activeSessions = nosebleedSessions.GetSessions();
        var managedPids = nosebleedSessions.GetManagedProcessIds();
        var allProcesses = nosebleedProcessInspector.GetProcesses()
            .GroupBy(x => x.ProcessId)
            .ToDictionary(x => x.Key, x => x.First());
        var orphanProcesses = nosebleedProcessInspector.GetOrphanProcesses(managedPids);

        var activeGameIds = activeSessions.Select(x => x.GameId).Distinct().ToArray();
        var activeGameNames = activeGameIds.Length == 0
            ? new Dictionary<int, string>()
            : await db.Games
                .AsNoTracking()
                .Where(x => activeGameIds.Contains(x.Id))
                .Select(x => new { x.Id, x.Name })
                .ToDictionaryAsync(x => x.Id, x => x.Name, cancellationToken);

        var arcadeSessionMap = await db.ArcadeCabinets
            .AsNoTracking()
            .Where(x => x.RuntimeSessionId != null)
            .Select(x => new { x.Id, x.DisplayName, x.RuntimeSessionId })
            .ToDictionaryAsync(x => x.RuntimeSessionId!, x => new { x.Id, x.DisplayName }, StringComparer.OrdinalIgnoreCase, cancellationToken);

        var roomCodeMap = await db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.Status == GamePlayRoomStatus.Active && x.NosebleedSessionId != null)
            .Select(x => new { x.NosebleedSessionId, x.Code })
            .ToDictionaryAsync(x => x.NosebleedSessionId!, x => x.Code, StringComparer.OrdinalIgnoreCase, cancellationToken);

        var activeSessionModels = activeSessions
            .Select(x =>
            {
                var isArcadeCabinet = arcadeSessionMap.TryGetValue(x.SessionId, out var arcadeCabinet);
                return new NosebleedRuntimeProcessViewModel
                {
                    SessionId = x.SessionId,
                    GameId = x.GameId,
                    FileId = x.FileId,
                    GameName = activeGameNames.TryGetValue(x.GameId, out var name) ? name : $"Game #{x.GameId}",
                    Port = x.Port,
                    BaseUrl = x.BaseUrl,
                    StartedUtc = x.StartedUtc,
                    Runtime = x.Runtime,
                    CorePath = x.CorePath,
                    ContentPath = x.ContentPath,
                    ProcessId = x.ProcessId,
                    HasExited = x.HasExited,
                    IsManaged = true,
                    IsArcadeCabinet = isArcadeCabinet,
                    ArcadeCabinetName = isArcadeCabinet ? arcadeCabinet!.DisplayName : null,
                    RoomCode = roomCodeMap.TryGetValue(x.SessionId, out var roomCode) ? roomCode : null,
                    CommandLine = allProcesses.TryGetValue(x.ProcessId, out var process) ? process.CommandLine : null,
                    AverageCpuPercent = allProcesses.TryGetValue(x.ProcessId, out process) ? process.AverageCpuPercent : null,
                    WorkingSetBytes = allProcesses.TryGetValue(x.ProcessId, out process) ? process.WorkingSetBytes : null
                };
            })
            .ToList();

        var runtimeSessionIds = activeSessionModels
            .Select(x => x.SessionId)
            .Concat(orphanProcesses.Select(x => x.SessionId).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var runtimeRoomRows = runtimeSessionIds.Length == 0
            ? []
            : await db.GamePlayRooms
                .AsNoTracking()
                .Where(x => x.NosebleedSessionId != null && runtimeSessionIds.Contains(x.NosebleedSessionId))
                .Select(x => new AdminRuntimeRoomRow(
                    x.Id,
                    x.NosebleedSessionId!,
                    x.Code,
                    x.IsArcadeBound,
                    x.ArcadeCabinet != null ? x.ArcadeCabinet.DisplayName : null,
                    x.GameId,
                    x.Game.Name,
                    x.CreatedByProfile != null ? x.CreatedByProfile.DisplayName : null,
                    x.CreatedByProfile != null ? x.CreatedByProfile.Username : null))
                .ToListAsync(cancellationToken);
        var runtimeArcadeRoomRows = runtimeSessionIds.Length == 0
            ? []
            : await db.GamePlayRooms
                .AsNoTracking()
                .Where(x => x.ArcadeCabinet != null && x.ArcadeCabinet.RuntimeSessionId != null && runtimeSessionIds.Contains(x.ArcadeCabinet.RuntimeSessionId))
                .Select(x => new AdminRuntimeRoomRow(
                    x.Id,
                    x.ArcadeCabinet!.RuntimeSessionId!,
                    x.Code,
                    true,
                    x.ArcadeCabinet.DisplayName,
                    x.GameId,
                    x.Game.Name,
                    x.CreatedByProfile != null ? x.CreatedByProfile.DisplayName : null,
                    x.CreatedByProfile != null ? x.CreatedByProfile.Username : null))
                .ToListAsync(cancellationToken);
        runtimeRoomRows.AddRange(runtimeArcadeRoomRows);

        var runtimeRoomBySessionId = runtimeRoomRows
            .GroupBy(x => x.SessionId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(x => x.Key, x => x.OrderByDescending(room => room.Id).First(), StringComparer.OrdinalIgnoreCase);

        var runtimeRoomIds = runtimeRoomRows.Select(x => x.Id).Distinct().ToArray();
        var runtimeParticipantRows = runtimeRoomIds.Length == 0
            ? []
            : await db.GamePlayRoomParticipants
                .AsNoTracking()
                .Where(x => runtimeRoomIds.Contains(x.RoomId) && x.IsConnected)
                .Select(x => new
                {
                    x.RoomId,
                    Name = x.Profile != null ? x.Profile.DisplayName : x.DisplayNameSnapshot
                })
                .ToListAsync(cancellationToken);
        var runtimeParticipantsByRoomId = runtimeParticipantRows
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .GroupBy(x => x.RoomId)
            .ToDictionary(
                x => x.Key,
                x => string.Join(", ", x.Select(participant => participant.Name!).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(name => name)));

        foreach (var session in activeSessionModels)
        {
            if (!runtimeRoomBySessionId.TryGetValue(session.SessionId, out var room))
            {
                continue;
            }

            session.IsArcadeCabinet = session.IsArcadeCabinet || room.IsArcadeBound;
            session.ArcadeCabinetName ??= room.ArcadeCabinetName;
            session.RoomCode ??= room.Code;
            session.CreatedByProfileName = room.CreatedByProfileName;
            session.CreatedByProfileUsername = room.CreatedByProfileUsername;
            session.ActiveParticipantNames = runtimeParticipantsByRoomId.TryGetValue(room.Id, out var names) ? names : null;
        }

        var runtimeProcesses = activeSessionModels
            .Concat(orphanProcesses.Select(process =>
            {
                var sessionId = process.SessionId ?? $"pid:{process.ProcessId}";
                runtimeRoomBySessionId.TryGetValue(sessionId, out var room);
                var participants = room is not null && runtimeParticipantsByRoomId.TryGetValue(room.Id, out var names) ? names : null;
                return new NosebleedRuntimeProcessViewModel
                {
                    ProcessId = process.ProcessId,
                    SessionId = sessionId,
                    GameId = room?.GameId,
                    GameName = room?.GameName ?? Path.GetFileNameWithoutExtension(process.ContentPath ?? string.Empty),
                    Port = process.Port,
                    IsManaged = false,
                    IsArcadeCabinet = room?.IsArcadeBound == true,
                    ArcadeCabinetName = room?.ArcadeCabinetName,
                    RoomCode = room?.Code,
                    CreatedByProfileName = room?.CreatedByProfileName,
                    CreatedByProfileUsername = room?.CreatedByProfileUsername,
                    ActiveParticipantNames = participants,
                    CorePath = process.CorePath,
                    ContentPath = process.ContentPath,
                    CommandLine = process.CommandLine,
                    AverageCpuPercent = process.AverageCpuPercent,
                    WorkingSetBytes = process.WorkingSetBytes
                };
            }))
            .OrderByDescending(x => x.IsManaged)
            .ThenBy(x => x.SessionKind)
            .ThenBy(x => x.GameName)
            .ThenBy(x => x.ProcessId)
            .ToList();

        var streamSettings = streamSettingsStore.Get();

        var missingSystemFilesCount = ComputeMissingSystemFilesCount();

        return View(new AdminIndexViewModel
        {
            GamesCount = await db.Games.AsNoTracking().CountAsync(cancellationToken),
            GameFilesCount = await db.GameFiles.AsNoTracking().CountAsync(cancellationToken),
            SystemFilesCount = await db.SystemFiles.AsNoTracking().CountAsync(cancellationToken),
            StreamSettings = new AdminStreamSettingsViewModel
            {
                PreferredVideoTransport = streamSettings.PreferredVideoTransport,
                MediaBackend = streamSettings.MediaBackend
            },
            NosebleedRuntimeProcesses = runtimeProcesses,
            LibretroDatabaseInstalled = libretroStore.HasDatFiles(),
            MissingSystemFilesCount = missingSystemFilesCount
        });

        int? ComputeMissingSystemFilesCount()
        {
            if (!libretroStore.HasDatFiles()) return null;
            var idx = systemDat.Get();
            return idx.ByPath.Values.Count(x => !System.IO.File.Exists(systemFileStorage.GetAbsoluteSystemPath(x.RelativePath)));
        }
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult SaveStreamSettings(AdminStreamSettingsViewModel model)
    {
        var saved = streamSettingsStore.Save(new NosebleedStreamSettings
        {
            PreferredVideoTransport = model.PreferredVideoTransport,
            MediaBackend = "GStreamer"
        });

        TempData["AdminMessage"] = $"Stream settings saved. New sessions will use GStreamer with {saved.PreferredVideoTransport} transport.";
        return Redirect($"{Url.Action(nameof(Index))}#admin-stream-settings");
    }
}

internal sealed record AdminRuntimeRoomRow(
    int Id,
    string SessionId,
    string Code,
    bool IsArcadeBound,
    string? ArcadeCabinetName,
    int GameId,
    string GameName,
    string? CreatedByProfileName,
    string? CreatedByProfileUsername);
