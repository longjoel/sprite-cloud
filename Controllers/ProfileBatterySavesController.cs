using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;

namespace games_vault.Controllers;

public sealed class ProfileBatterySavesController(
    AppDbContext db,
    GameFileStorage fileStorage,
    CurrentProfileService currentProfile,
    ProfileBatterySaveService batterySaveService,
    BatterySaveRuntimeSyncService batterySaveRuntimeSyncService,
    BatterySavePolicyResolver batterySavePolicyResolver,
    NosebleedSessionManager nosebleedSessions) : Controller
{
    private const string BatterySaveDiagnosticsTempDataKey = "BatterySaveDiagnostics";
    private static readonly JsonSerializerOptions BatterySaveDiagnosticsJsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".sav",
        ".srm"
    };

    [HttpGet]
    public async Task<IActionResult> Upload(int gameId, int gameFileId, string? key = null, string? fileName = null, string? returnUrl = null, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(gameId, gameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        return View(new ProfileBatterySaveUploadViewModel
        {
            GameId = gameId,
            GameFileId = gameFileId,
            GameName = file.Game.Name,
            GameFileName = file.Name,
            SystemName = file.Game.SystemName,
            Key = string.IsNullOrWhiteSpace(key) ? "default" : key.Trim(),
            FileName = fileName,
            ReturnUrl = returnUrl
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Upload(ProfileBatterySaveUploadViewModel model, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(model.GameId, model.GameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        model.GameName = file.Game.Name;
        model.GameFileName = file.Name;
        model.SystemName = file.Game.SystemName;
        model.Key = string.IsNullOrWhiteSpace(model.Key) ? "default" : model.Key.Trim();
        model.FileName = string.IsNullOrWhiteSpace(model.FileName) ? null : Path.GetFileName(model.FileName.Trim());

        if (model.Upload is null || model.Upload.Length <= 0)
        {
            ModelState.AddModelError(nameof(model.Upload), "Choose a .sav or .srm file to upload.");
        }
        else if (!AllowedExtensions.Contains(Path.GetExtension(model.Upload.FileName)))
        {
            ModelState.AddModelError(nameof(model.Upload), "Only .sav and .srm files are supported for battery saves.");
        }

        if (!ModelState.IsValid)
        {
            return View(model);
        }

        var saveFileName = string.IsNullOrWhiteSpace(model.FileName)
            ? Path.GetFileName(model.Upload!.FileName)
            : model.FileName!;

        await using var input = model.Upload!.OpenReadStream();
        await batterySaveService.AppendUploadedRevisionAsync(
            profile.Id,
            file.GameId,
            file.Id,
            file.Game.SystemName,
            coreKey: null,
            key: model.Key,
            fileName: saveFileName,
            originalUploadFileName: Path.GetFileName(model.Upload.FileName),
            content: input,
            timestampUtc: DateTime.UtcNow,
            cancellationToken);

        SetBatterySaveNotification("good", "Battery saves", "Battery save uploaded.");
        return RedirectToAction(nameof(History), new { gameId = file.GameId, gameFileId = file.Id });
    }

    [HttpGet]
    public async Task<IActionResult> History(int gameId, int gameFileId, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(gameId, gameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        var diagnostics = ReadDiagnosticsFromTempData();
        var revisions = await batterySaveService.GetHistoryAsync(profile.Id, file.GameId, file.Id, cancellationToken);
        return View(new ProfileBatterySaveHistoryViewModel
        {
            GameId = file.GameId,
            GameFileId = file.Id,
            GameName = file.Game.Name,
            GameFileName = file.Name,
            SystemName = file.Game.SystemName,
            Revisions = revisions.Select(x => new ProfileBatterySaveHistoryRow
            {
                RevisionId = x.RevisionId,
                ProfileGameSaveId = x.ProfileGameSaveId,
                Key = x.Key,
                FileName = x.FileName,
                CoreKey = x.CoreKey,
                Kind = x.Kind,
                RevisionTimestampUtc = x.RevisionTimestampUtc,
                StoragePath = x.StoragePath,
                SizeBytes = x.SizeBytes,
                Sha256 = x.Sha256,
                Source = x.Source,
                OriginalUploadFileName = x.OriginalUploadFileName,
                GamePlaySessionId = x.GamePlaySessionId,
                IsLatest = x.IsLatest
            }).ToList(),
            Diagnostics = diagnostics
        });
    }

    [HttpGet]
    public async Task<IActionResult> Download(int gameId, int gameFileId, int revisionId, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(gameId, gameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        var revision = await db.ProfileGameSaveRevisions
            .AsNoTracking()
            .Include(x => x.ProfileGameSave)
            .FirstOrDefaultAsync(x => x.Id == revisionId
                && x.ProfileGameSave.ProfileId == profile.Id
                && x.ProfileGameSave.GameId == file.GameId
                && x.ProfileGameSave.GameFileId == file.Id,
                cancellationToken);
        if (revision is null)
        {
            return NotFound();
        }

        var bytes = await batterySaveService.ReadRevisionBytesAsync(profile.Id, revisionId, cancellationToken);
        if (bytes is null)
        {
            return NotFound();
        }

        return File(bytes, "application/octet-stream", revision.ProfileGameSave.FileName);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Rename(int gameId, int gameFileId, int profileGameSaveId, string fileName, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(gameId, gameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        if (string.IsNullOrWhiteSpace(fileName))
        {
            ModelState.AddModelError(nameof(fileName), "Enter a new filename for the save.");
            return await History(gameId, gameFileId, cancellationToken);
        }

        var renamed = await batterySaveService.RenameSaveAsync(profile.Id, profileGameSaveId, fileName, cancellationToken);
        if (renamed is null || renamed.GameId != file.GameId || renamed.GameFileId != file.Id)
        {
            return NotFound();
        }

        SetBatterySaveNotification("good", "Battery saves", $"Renamed save to {renamed.FileName}.");
        return RedirectToAction(nameof(History), new { gameId = file.GameId, gameFileId = file.Id });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> LoadAndReset(int gameId, int gameFileId, int revisionId, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(gameId, gameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        var promoted = await batterySaveService.PromoteRevisionToLatestAsync(profile.Id, revisionId, DateTime.UtcNow, cancellationToken);
        if (promoted is null)
        {
            return NotFound();
        }

        var diagnostics = new List<ProfileBatterySaveLogEntry>
        {
            new("good", "Battery saves", $"Promoted revision {promoted.Id} to latest for {promoted.ProfileGameSave.FileName}.")
        };

        var activeRoom = await FindActiveRoomAsync(profile.Id, file.GameId, file.Id, cancellationToken);
        var liveSession = activeRoom is null
            ? null
            : nosebleedSessions.GetSessions().FirstOrDefault(x => string.Equals(x.SessionId, activeRoom.NosebleedSessionId, StringComparison.OrdinalIgnoreCase) && !x.HasExited);

        if (activeRoom is not null && !string.IsNullOrWhiteSpace(activeRoom.NosebleedSessionId))
        {
            diagnostics.Add(new ProfileBatterySaveLogEntry("good", "Battery saves", $"Found active room {activeRoom.Id} for session {activeRoom.NosebleedSessionId}."));
            var policy = batterySavePolicyResolver.Resolve(activeRoom, profile);

            if (liveSession is not null)
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("good", "Live reset", $"Found active live session {liveSession.SessionId}; will restore the save and reset it in place."));
            }

            var runtimeSaveBaseName = GetRuntimeSaveBaseName(file);
            var restoredCount = await batterySaveRuntimeSyncService.PrepareRuntimeSaveDirectoryAsync(
                policy,
                file.GameId,
                file.Id,
                activeRoom.Game.SystemName,
                activeRoom.NosebleedSessionId!,
                runtimeSaveBaseName,
                cancellationToken);

            var runtimeSaveDirectory = batterySaveRuntimeSyncService.GetRuntimeSaveDirectory(activeRoom.NosebleedSessionId!);
            var restoreProfileId = policy.ProfileId ?? profile.Id;
            if (policy.Mode != BatterySavePersistenceMode.PerProfile || policy.ProfileId is null)
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("warn", "Runtime restore", $"Battery saves are disabled for session {activeRoom.NosebleedSessionId}; no runtime restore was attempted."));
            }
            else if (restoredCount > 0)
            {
                var restoredRuntimeFiles = Directory.EnumerateFiles(runtimeSaveDirectory, "*", SearchOption.TopDirectoryOnly)
                    .Where(path => AllowedExtensions.Contains(Path.GetExtension(path)))
                    .Select(Path.GetFileName)
                    .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
                var restoredFileList = restoredRuntimeFiles.Count > 0
                    ? string.Join(", ", restoredRuntimeFiles)
                    : "(file list unavailable)";
                diagnostics.Add(new ProfileBatterySaveLogEntry("good", "Runtime restore", $"Restored {restoredCount} runtime save file(s) into {runtimeSaveDirectory}: {restoredFileList}."));
            }
            else
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("warn", "Runtime restore", $"No runtime save files were restored into {runtimeSaveDirectory} for profile {restoreProfileId}."));
            }

            var resetResult = await nosebleedSessions.TryRequestResetAsync(activeRoom.NosebleedSessionId!, 0, cancellationToken);
            diagnostics.Add(resetResult.Success
                ? new ProfileBatterySaveLogEntry("good", "Live reset", $"Requested a live reset for session {activeRoom.NosebleedSessionId}.")
                : new ProfileBatterySaveLogEntry("bad", "Live reset", $"Live reset request failed for session {activeRoom.NosebleedSessionId}: {resetResult.Error}"));

            SetBatterySaveNotification(resetResult.Success
                ? "good"
                : "bad",
                "Battery saves",
                resetResult.Success
                    ? "Save loaded and the live session was reset."
                    : $"Save loaded, but the live reset failed: {resetResult.Error}");
        }
        else
        {
            diagnostics.Add(new ProfileBatterySaveLogEntry("warn", "Runtime restore", "No active room was found, so the save will seed the next session start."));
            SetBatterySaveNotification("good", "Battery saves", "Save loaded. It will be used on the next session start.");
        }

        TempData[BatterySaveDiagnosticsTempDataKey] = JsonSerializer.Serialize(diagnostics, BatterySaveDiagnosticsJsonOptions);

        return RedirectToAction(nameof(History), new { gameId = file.GameId, gameFileId = file.Id });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(int gameId, int gameFileId, int revisionId, CancellationToken cancellationToken = default)
    {
        var profile = await currentProfile.GetCurrentAsync(cancellationToken);
        if (profile is null || profile.IsEphemeral)
        {
            return Forbid();
        }

        var file = await LoadGameFileAsync(gameId, gameFileId, cancellationToken);
        if (file is null)
        {
            return NotFound();
        }

        var deleted = await batterySaveService.DeleteRevisionAsync(profile.Id, revisionId, cancellationToken);
        if (!deleted)
        {
            return NotFound();
        }

        SetBatterySaveNotification("good", "Battery saves", "Save revision deleted.");
        return RedirectToAction(nameof(History), new { gameId = file.GameId, gameFileId = file.Id });
    }

    private IReadOnlyList<ProfileBatterySaveLogEntry> ReadDiagnosticsFromTempData()
    {
        var diagnostics = new List<ProfileBatterySaveLogEntry>();
        var rawDiagnostics = TempData.Peek(BatterySaveDiagnosticsTempDataKey) as string;

        if (!string.IsNullOrWhiteSpace(rawDiagnostics))
        {
            try
            {
                var parsedDiagnostics = JsonSerializer.Deserialize<List<ProfileBatterySaveLogEntry>>(rawDiagnostics, BatterySaveDiagnosticsJsonOptions);
                if (parsedDiagnostics is not null)
                {
                    diagnostics.AddRange(parsedDiagnostics);
                }
            }
            catch (JsonException)
            {
                diagnostics.Add(new ProfileBatterySaveLogEntry("warn", "Battery saves", "Backend diagnostics could not be read."));
            }
        }
        else if (TempData.Peek("Message") is string message && !string.IsNullOrWhiteSpace(message))
        {
            diagnostics.Add(new ProfileBatterySaveLogEntry("good", "Battery saves", message));
        }

        return diagnostics;
    }

    private void SetBatterySaveNotification(string level, string title, string message)
    {
        TempData["Message"] = message;
        TempData[BatterySaveDiagnosticsTempDataKey] = JsonSerializer.Serialize(
            new[] { new ProfileBatterySaveLogEntry(level, title, message) },
            BatterySaveDiagnosticsJsonOptions);
    }

    private async Task<GamePlayRoom?> FindActiveRoomAsync(int profileId, int gameId, int gameFileId, CancellationToken cancellationToken)
    {
        return await db.GamePlayRooms
            .AsNoTracking()
            .Include(x => x.Game)
            .Where(x => x.Status == GamePlayRoomStatus.Active
                && !x.IsArcadeBound
                && x.GameId == gameId
                && x.GameFileId == gameFileId
                && (x.CreatedByProfileId == profileId || x.Participants.Any(p => p.ProfileId == profileId && p.Role == GamePlayRoomParticipantRole.Player)))
            .OrderByDescending(x => x.LastActiveUtc)
            .ThenByDescending(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);
    }

    private async Task<games_vault.Models.GameFile?> LoadGameFileAsync(int gameId, int gameFileId, CancellationToken cancellationToken)
    {
        return await db.GameFiles
            .AsNoTracking()
            .Include(x => x.Game)
            .FirstOrDefaultAsync(x => x.Id == gameFileId && x.GameId == gameId, cancellationToken);
    }

    private async Task<string?> ResolveGameFileAbsolutePathAsync(GameFile file, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(file.StoragePath))
        {
            return fileStorage.GetAbsolutePath(file.StoragePath);
        }

        if (string.IsNullOrWhiteSpace(file.ExternalPath))
        {
            return null;
        }

        var full = Path.GetFullPath(file.ExternalPath);
        var allowedRoots = await db.LocalFolders
            .AsNoTracking()
            .Where(f => f.Enabled)
            .Select(f => f.RootPath)
            .ToListAsync(cancellationToken);

        var allowed = allowedRoots.Any(root =>
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                return false;
            }

            var rootFull = Path.GetFullPath(root);
            if (!rootFull.EndsWith(Path.DirectorySeparatorChar))
            {
                rootFull += Path.DirectorySeparatorChar;
            }

            return full.StartsWith(rootFull, StringComparison.Ordinal);
        });

        return allowed && System.IO.File.Exists(full) ? full : null;
    }

    private static string? GetRuntimeSaveBaseName(GameFile file)
    {
        var source = file.ExternalPath ?? file.StoragePath ?? file.Name;
        if (string.IsNullOrWhiteSpace(source))
        {
            return null;
        }

        return Path.GetFileNameWithoutExtension(source);
    }
}
