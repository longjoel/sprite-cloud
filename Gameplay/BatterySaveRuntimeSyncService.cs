using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.Extensions.Options;

namespace games_vault.Gameplay;

public sealed class BatterySaveRuntimeSyncService(
    ProfileBatterySaveService batterySaveService,
    ProfileGameSaveStorage storage,
    IOptions<NosebleedOptions> nosebleedOptions,
    ILogger<BatterySaveRuntimeSyncService> logger)
{
    private readonly ILogger<BatterySaveRuntimeSyncService> _logger = logger;
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".sav",
        ".srm",
        ".ram"
    };

    private readonly NosebleedOptions _nosebleedOptions = nosebleedOptions.Value ?? new NosebleedOptions();

    public string GetRuntimeSaveDirectory(string sessionId)
    {
        sessionId = NormalizeRequired(sessionId, nameof(sessionId));
        var root = Path.GetFullPath(_nosebleedOptions.SessionRoot);
        return Path.Combine(root, "save-data", SanitizeSessionId(sessionId));
    }

    public async Task<int> PrepareRuntimeSaveDirectoryAsync(
        BatterySavePolicy policy,
        int gameId,
        int gameFileId,
        string systemName,
        string sessionId,
        string? runtimeSaveBaseName,
        CancellationToken cancellationToken)
    {
        var runtimeSaveDirectory = GetRuntimeSaveDirectory(sessionId);

        if (policy.Mode != BatterySavePersistenceMode.PerProfile || policy.ProfileId is not int profileId)
        {
            _logger.LogInformation(
                "Skipping runtime save restore for session {SessionId} because battery saves are disabled for this policy ({Mode}). Runtime dir: {RuntimeSaveDirectory}",
                sessionId,
                policy.Mode,
                runtimeSaveDirectory);
            return 0;
        }

        Directory.CreateDirectory(runtimeSaveDirectory);
        _logger.LogInformation(
            "Prepared runtime save directory {RuntimeSaveDirectory} for profile {ProfileId}, game {GameId}/{GameFileId} ({SystemName})",
            runtimeSaveDirectory,
            profileId,
            gameId,
            gameFileId,
            systemName);

        var restoredCount = 0;
        var latestRevisions = await batterySaveService.GetLatestRevisionsAsync(
            profileId,
            gameId,
            gameFileId,
            coreKey: null,
            key: "default",
            cancellationToken);

        foreach (var item in latestRevisions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!AllowedExtensions.Contains(Path.GetExtension(item.FileName)))
            {
                continue;
            }

            var sourcePath = storage.GetAbsolutePath(item.Revision.StoragePath);
            if (!File.Exists(sourcePath))
            {
                continue;
            }

            var runtimeFileName = BuildRuntimeSaveFileName(runtimeSaveBaseName, item.FileName);
            var targetPath = Path.Combine(runtimeSaveDirectory, runtimeFileName);
            var targetDir = Path.GetDirectoryName(targetPath);
            if (!string.IsNullOrWhiteSpace(targetDir))
            {
                Directory.CreateDirectory(targetDir);
            }

            File.Copy(sourcePath, targetPath, overwrite: true);
            restoredCount++;
        }

        restoredCount += await RestoreRuntimeSaveStatesAsync(
            policy,
            gameId,
            gameFileId,
            systemName,
            runtimeSaveDirectory,
            runtimeSaveBaseName,
            cancellationToken);

        return restoredCount;
    }

    public async Task<int> CaptureRuntimeSaveRevisionsAsync(
        BatterySavePolicy policy,
        int gameId,
        int gameFileId,
        string systemName,
        string sessionId,
        CancellationToken cancellationToken)
    {
        if (policy.Mode != BatterySavePersistenceMode.PerProfile || policy.ProfileId is not int profileId)
        {
            return 0;
        }

        var runtimeSaveDirectory = GetRuntimeSaveDirectory(sessionId);
        if (!Directory.Exists(runtimeSaveDirectory))
        {
            _logger.LogWarning(
                "Runtime save capture skipped because directory does not exist: {RuntimeSaveDirectory} (session {SessionId}, game {GameId}/{GameFileId}, system {SystemName})",
                runtimeSaveDirectory,
                sessionId,
                gameId,
                gameFileId,
                systemName);
            return 0;
        }

        var runtimeFiles = Directory.EnumerateFiles(runtimeSaveDirectory, "*", SearchOption.TopDirectoryOnly)
            .Where(path => AllowedExtensions.Contains(Path.GetExtension(path)))
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var capturedCount = 0;
        if (runtimeFiles.Count == 0)
        {
            _logger.LogWarning(
                "Runtime save capture found no .sav/.srm/.ram files in {RuntimeSaveDirectory} for session {SessionId} (profile {ProfileId}, game {GameId}/{GameFileId}, system {SystemName})",
                runtimeSaveDirectory,
                sessionId,
                profileId,
                gameId,
                gameFileId,
                systemName);
        }
        else
        {
            _logger.LogInformation(
                "Capturing {RuntimeFileCount} runtime save file(s) from {RuntimeSaveDirectory} for session {SessionId} (profile {ProfileId}, game {GameId}/{GameFileId}, system {SystemName}): {RuntimeFiles}",
                runtimeFiles.Count,
                runtimeSaveDirectory,
                sessionId,
                profileId,
                gameId,
                gameFileId,
                systemName,
                string.Join(", ", runtimeFiles.Select(Path.GetFileName)));

            foreach (var path in runtimeFiles)
            {
                cancellationToken.ThrowIfCancellationRequested();

                await using var input = File.OpenRead(path);
                await batterySaveService.AppendRuntimeRevisionAsync(
                    profileId,
                    gameId,
                    gameFileId,
                    systemName,
                    coreKey: null,
                    key: "default",
                    fileName: Path.GetFileName(path),
                    content: input,
                    timestampUtc: DateTime.UtcNow,
                    cancellationToken);
                _logger.LogInformation(
                    "Captured runtime save file {RuntimeSaveFile} from session {SessionId} into profile {ProfileId} game {GameId}/{GameFileId}",
                    Path.GetFileName(path),
                    sessionId,
                    profileId,
                    gameId,
                    gameFileId);
                capturedCount++;
            }
        }

        capturedCount += await CaptureRuntimeSaveStatesAsync(
            policy,
            gameId,
            gameFileId,
            systemName,
            sessionId,
            runtimeSaveDirectory,
            cancellationToken);

        return capturedCount;
    }

    private async Task<int> RestoreRuntimeSaveStatesAsync(
        BatterySavePolicy policy,
        int gameId,
        int gameFileId,
        string systemName,
        string runtimeSaveDirectory,
        string? runtimeSaveBaseName,
        CancellationToken cancellationToken)
    {
        if (policy.Mode != BatterySavePersistenceMode.PerProfile || policy.ProfileId is not int profileId)
        {
            return 0;
        }

        var restoredCount = 0;
        for (var slot = 1; slot <= 5; slot++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var slotKey = BuildStateSlotKey(slot);
            var slotFileName = BuildStateSlotFileName(slot);
            var latest = await batterySaveService.GetLatestSaveStateRevisionAsync(
                profileId,
                gameId,
                gameFileId,
                coreKey: null,
                key: slotKey,
                fileName: slotFileName,
                cancellationToken);

            if (latest is null)
            {
                continue;
            }

            var sourcePath = storage.GetAbsolutePath(latest.StoragePath);
            if (!File.Exists(sourcePath))
            {
                continue;
            }

            var targetPath = BuildRuntimeSaveStatePath(runtimeSaveDirectory, runtimeSaveBaseName, slot);
            var targetDir = Path.GetDirectoryName(targetPath);
            if (!string.IsNullOrWhiteSpace(targetDir))
            {
                Directory.CreateDirectory(targetDir);
            }

            File.Copy(sourcePath, targetPath, overwrite: true);
            _logger.LogInformation(
                "Restored save state slot {Slot} into {RuntimeSaveStatePath} for session {SessionId} (profile {ProfileId}, game {GameId}/{GameFileId}, system {SystemName})",
                slot,
                targetPath,
                Path.GetFileName(runtimeSaveDirectory),
                profileId,
                gameId,
                gameFileId,
                systemName);
            restoredCount++;
        }

        return restoredCount;
    }

    private async Task<int> CaptureRuntimeSaveStatesAsync(
        BatterySavePolicy policy,
        int gameId,
        int gameFileId,
        string systemName,
        string sessionId,
        string runtimeSaveDirectory,
        CancellationToken cancellationToken)
    {
        if (policy.Mode != BatterySavePersistenceMode.PerProfile || policy.ProfileId is not int profileId)
        {
            return 0;
        }

        var stateFiles = Directory.EnumerateFiles(runtimeSaveDirectory, "*.state", SearchOption.AllDirectories)
            .Where(path => TryParseStateSlot(path, out _))
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (stateFiles.Count == 0)
        {
            return 0;
        }

        _logger.LogInformation(
            "Capturing {StateFileCount} save state file(s) from {RuntimeSaveDirectory} for session {SessionId} (profile {ProfileId}, game {GameId}/{GameFileId}, system {SystemName}): {StateFiles}",
            stateFiles.Count,
            runtimeSaveDirectory,
            sessionId,
            profileId,
            gameId,
            gameFileId,
            systemName,
            string.Join(", ", stateFiles.Select(Path.GetFileName)));

        var capturedCount = 0;
        foreach (var path in stateFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryParseStateSlot(path, out var slot))
            {
                continue;
            }

            await using var input = File.OpenRead(path);
            await batterySaveService.AppendRuntimeSaveStateRevisionAsync(
                profileId,
                gameId,
                gameFileId,
                systemName,
                coreKey: null,
                key: BuildStateSlotKey(slot),
                fileName: BuildStateSlotFileName(slot),
                content: input,
                timestampUtc: DateTime.UtcNow,
                cancellationToken);
            _logger.LogInformation(
                "Captured save state slot {Slot} from session {SessionId} into profile {ProfileId} game {GameId}/{GameFileId}",
                slot,
                sessionId,
                profileId,
                gameId,
                gameFileId);
            capturedCount++;
        }

        return capturedCount;
    }

    private static string BuildStateSlotKey(int slot) => $"slot-{Math.Clamp(slot, 1, 5):00}";

    private static string BuildStateSlotFileName(int slot) => $"slot-{Math.Clamp(slot, 1, 5):00}.state";

    private static string BuildRuntimeSaveStatePath(string runtimeSaveDirectory, string? runtimeSaveBaseName, int slot)
    {
        var baseName = string.IsNullOrWhiteSpace(runtimeSaveBaseName)
            ? "save"
            : Path.GetFileNameWithoutExtension(runtimeSaveBaseName.Trim());
        if (string.IsNullOrWhiteSpace(baseName))
        {
            baseName = "save";
        }

        return Path.Combine(runtimeSaveDirectory, "states", baseName, BuildStateSlotFileName(slot));
    }

    private static bool TryParseStateSlot(string path, out int slot)
    {
        slot = 0;
        var fileName = Path.GetFileNameWithoutExtension(path);
        if (string.IsNullOrWhiteSpace(fileName) || !fileName.StartsWith("slot-", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return int.TryParse(fileName[5..], out slot) && slot is >= 1 and <= 5;
    }

    private static string NormalizeRequired(string value, string paramName)
    {
        value = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{paramName} is required.", paramName);
        }

        return value;
    }

    private static string SanitizeSessionId(string raw)
    {
        var chars = raw
            .Trim()
            .Select(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '_')
            .ToArray();
        return chars.Length == 0 ? "session" : new string(chars);
    }

    private static string BuildRuntimeSaveFileName(string? runtimeSaveBaseName, string sourceFileName)
    {
        var extension = Path.GetExtension(sourceFileName);
        var baseName = string.IsNullOrWhiteSpace(runtimeSaveBaseName)
            ? Path.GetFileNameWithoutExtension(sourceFileName)
            : Path.GetFileNameWithoutExtension(runtimeSaveBaseName.Trim());
        if (string.IsNullOrWhiteSpace(baseName))
        {
            baseName = "save";
        }

        return string.IsNullOrWhiteSpace(extension) ? baseName : baseName + extension;
    }
}
