using System.Security.Cryptography;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Gameplay;

public sealed class ProfileBatterySaveService(AppDbContext db, ProfileGameSaveStorage storage)
{
    public async Task<ProfileGameSaveRevision> AppendRuntimeRevisionAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string systemName,
        string? coreKey,
        string key,
        string fileName,
        Stream content,
        DateTime timestampUtc,
        CancellationToken cancellationToken)
    {
        return await AppendRevisionAsync(
            profileId,
            gameId,
            gameFileId,
            systemName,
            coreKey,
            kind: "battery",
            key: key,
            fileName: fileName,
            content: content,
            timestampUtc: timestampUtc,
            source: "runtime",
            originalUploadFileName: null,
            cancellationToken: cancellationToken);
    }

    public async Task<ProfileGameSaveRevision> AppendRuntimeSaveStateRevisionAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string systemName,
        string? coreKey,
        string key,
        string fileName,
        Stream content,
        DateTime timestampUtc,
        CancellationToken cancellationToken)
    {
        return await AppendRevisionAsync(
            profileId,
            gameId,
            gameFileId,
            systemName,
            coreKey,
            kind: "savestate",
            key: key,
            fileName: fileName,
            content: content,
            timestampUtc: timestampUtc,
            source: "runtime",
            originalUploadFileName: null,
            cancellationToken: cancellationToken);
    }

    public async Task<ProfileGameSaveRevision> AppendUploadedRevisionAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string systemName,
        string? coreKey,
        string key,
        string fileName,
        string? originalUploadFileName,
        Stream content,
        DateTime timestampUtc,
        CancellationToken cancellationToken)
    {
        return await AppendRevisionAsync(
            profileId,
            gameId,
            gameFileId,
            systemName,
            coreKey,
            kind: "battery",
            key: key,
            fileName: fileName,
            content: content,
            timestampUtc: timestampUtc,
            source: "upload",
            originalUploadFileName: originalUploadFileName,
            cancellationToken: cancellationToken);
    }

    public async Task<ProfileGameSaveRevision?> GetLatestRevisionAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string? coreKey,
        string key,
        string fileName,
        CancellationToken cancellationToken)
    {
        return await GetLatestRevisionForKindAsync(
            profileId: profileId,
            gameId: gameId,
            gameFileId: gameFileId,
            coreKey: coreKey,
            kind: "battery",
            key: key,
            fileName: fileName,
            cancellationToken: cancellationToken);
    }

    public async Task<ProfileGameSaveRevision?> GetLatestSaveStateRevisionAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string? coreKey,
        string key,
        string fileName,
        CancellationToken cancellationToken)
    {
        return await GetLatestRevisionForKindAsync(
            profileId: profileId,
            gameId: gameId,
            gameFileId: gameFileId,
            coreKey: coreKey,
            kind: "savestate",
            key: key,
            fileName: fileName,
            cancellationToken: cancellationToken);
    }

    private async Task<ProfileGameSaveRevision?> GetLatestRevisionForKindAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string? coreKey,
        string kind,
        string key,
        string fileName,
        CancellationToken cancellationToken)
    {
        var normalizedCoreKey = NormalizeNullable(coreKey);
        var normalizedKind = NormalizeRequired(kind, nameof(kind)).ToLowerInvariant();
        var normalizedKey = NormalizeRequired(key, nameof(key));
        var normalizedFileName = NormalizeRequired(fileName, nameof(fileName));

        return await db.ProfileGameSaves
            .AsNoTracking()
            .Where(x => x.ProfileId == profileId
                && x.GameId == gameId
                && x.GameFileId == gameFileId
                && x.CoreKey == normalizedCoreKey
                && x.Kind == normalizedKind
                && x.Key == normalizedKey
                && x.FileName == normalizedFileName)
            .Select(x => x.LatestRevision)
            .SingleOrDefaultAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ProfileBatterySaveLatestRevision>> GetLatestRevisionsAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string? coreKey,
        string key,
        CancellationToken cancellationToken)
    {
        var normalizedCoreKey = NormalizeNullable(coreKey);
        var normalizedKey = NormalizeRequired(key, nameof(key));

        return await db.ProfileGameSaves
            .AsNoTracking()
            .Where(x => x.ProfileId == profileId
                && x.GameId == gameId
                && x.GameFileId == gameFileId
                && x.CoreKey == normalizedCoreKey
                && x.Key == normalizedKey
                && x.LatestRevisionId != null)
            .OrderBy(x => x.FileName)
            .Select(x => new ProfileBatterySaveLatestRevision(
                x.Key,
                x.FileName,
                x.LatestRevision!))
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ProfileBatterySaveHistoryEntry>> GetHistoryAsync(
        int profileId,
        int gameId,
        int gameFileId,
        CancellationToken cancellationToken)
    {
        return await db.ProfileGameSaveRevisions
            .AsNoTracking()
            .Where(x => x.ProfileGameSave.ProfileId == profileId
                && x.ProfileGameSave.GameId == gameId
                && x.ProfileGameSave.GameFileId == gameFileId
                && x.ProfileGameSave.Kind == "battery")
            .OrderByDescending(x => x.RevisionTimestampUtc)
            .ThenByDescending(x => x.Id)
            .Select(x => new ProfileBatterySaveHistoryEntry(
                x.Id,
                x.ProfileGameSaveId,
                x.ProfileGameSave.ProfileId,
                x.ProfileGameSave.GameId,
                x.ProfileGameSave.GameFileId,
                x.ProfileGameSave.Key,
                x.ProfileGameSave.FileName,
                x.ProfileGameSave.CoreKey,
                x.ProfileGameSave.Kind,
                x.RevisionTimestampUtc,
                x.StoragePath,
                x.SizeBytes,
                x.Sha256,
                x.Source,
                x.OriginalUploadFileName,
                x.GamePlaySessionId,
                x.ProfileGameSave.LatestRevisionId == x.Id))
            .ToListAsync(cancellationToken);
    }

    public async Task<byte[]?> ReadRevisionBytesAsync(int profileId, int revisionId, CancellationToken cancellationToken)
    {
        var revision = await db.ProfileGameSaveRevisions
            .AsNoTracking()
            .Include(x => x.ProfileGameSave)
            .FirstOrDefaultAsync(x => x.Id == revisionId && x.ProfileGameSave.ProfileId == profileId, cancellationToken);

        if (revision is null)
        {
            return null;
        }

        var path = storage.GetAbsolutePath(revision.StoragePath);
        if (!File.Exists(path))
        {
            return null;
        }

        return await File.ReadAllBytesAsync(path, cancellationToken);
    }

    public async Task<ProfileGameSaveRevision?> PromoteRevisionToLatestAsync(int profileId, int revisionId, DateTime timestampUtc, CancellationToken cancellationToken)
    {
        var revision = await db.ProfileGameSaveRevisions
            .Include(x => x.ProfileGameSave)
            .FirstOrDefaultAsync(x => x.Id == revisionId && x.ProfileGameSave.ProfileId == profileId, cancellationToken);

        if (revision is null)
        {
            return null;
        }

        var save = revision.ProfileGameSave;
        save.LatestRevisionId = revision.Id;
        save.UpdatedUtc = timestampUtc.Kind == DateTimeKind.Utc ? timestampUtc : timestampUtc.ToUniversalTime();
        await db.SaveChangesAsync(cancellationToken);

        return revision;
    }

    public async Task<ProfileGameSave?> RenameSaveAsync(int profileId, int profileGameSaveId, string fileName, CancellationToken cancellationToken)
    {
        fileName = NormalizeRequired(fileName, nameof(fileName));
        fileName = Path.GetFileName(fileName);

        var save = await db.ProfileGameSaves
            .SingleOrDefaultAsync(x => x.Id == profileGameSaveId && x.ProfileId == profileId, cancellationToken);
        if (save is null)
        {
            return null;
        }

        save.FileName = fileName;
        save.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        return save;
    }

    public async Task<bool> DeleteRevisionAsync(int profileId, int revisionId, CancellationToken cancellationToken)
    {
        var revision = await db.ProfileGameSaveRevisions
            .Include(x => x.ProfileGameSave)
            .FirstOrDefaultAsync(x => x.Id == revisionId && x.ProfileGameSave.ProfileId == profileId, cancellationToken);
        if (revision is null)
        {
            return false;
        }

        var save = revision.ProfileGameSave;
        var wasLatest = save.LatestRevisionId == revision.Id;
        if (wasLatest)
        {
            var replacement = await db.ProfileGameSaveRevisions
                .AsNoTracking()
                .Where(x => x.ProfileGameSaveId == save.Id && x.Id != revision.Id)
                .OrderByDescending(x => x.RevisionTimestampUtc)
                .ThenByDescending(x => x.Id)
                .FirstOrDefaultAsync(cancellationToken);

            if (replacement is null)
            {
                save.LatestRevisionId = null;
                save.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(cancellationToken);
                db.ProfileGameSaves.Remove(save);
            }
            else
            {
                save.LatestRevisionId = replacement.Id;
                save.UpdatedUtc = DateTime.UtcNow;
                db.ProfileGameSaveRevisions.Remove(revision);
            }
        }
        else
        {
            db.ProfileGameSaveRevisions.Remove(revision);
        }

        await db.SaveChangesAsync(cancellationToken);

        try
        {
            var path = storage.GetAbsolutePath(revision.StoragePath);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Best-effort cleanup; the database is the source of truth.
        }

        return true;
    }

    private async Task<ProfileGameSaveRevision> AppendRevisionAsync(
        int profileId,
        int gameId,
        int gameFileId,
        string systemName,
        string? coreKey,
        string kind,
        string key,
        string fileName,
        Stream content,
        DateTime timestampUtc,
        string source,
        string? originalUploadFileName,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);

        var normalizedSystemName = NormalizeRequired(systemName, nameof(systemName));
        var normalizedCoreKey = NormalizeNullable(coreKey);
        var normalizedKind = NormalizeRequired(kind, nameof(kind)).ToLowerInvariant();
        var normalizedKey = NormalizeRequired(key, nameof(key));
        var normalizedFileName = NormalizeRequired(fileName, nameof(fileName));
        var normalizedSource = NormalizeRequired(source, nameof(source)).ToLowerInvariant();
        var normalizedUploadFileName = NormalizeNullable(originalUploadFileName);
        timestampUtc = timestampUtc.Kind == DateTimeKind.Utc ? timestampUtc : timestampUtc.ToUniversalTime();

        var bytes = await ReadAllBytesAsync(content, cancellationToken);
        var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

        // Query and create inside the transaction to prevent concurrent
        // creation races (TOCTOU between check and insert).
        using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            var save = await db.ProfileGameSaves
                .Include(x => x.LatestRevision)
                .SingleOrDefaultAsync(x => x.ProfileId == profileId
                    && x.GameId == gameId
                    && x.GameFileId == gameFileId
                    && x.CoreKey == normalizedCoreKey
                    && x.Kind == normalizedKind
                    && x.Key == normalizedKey
                    && x.FileName == normalizedFileName,
                    cancellationToken);

            if (save is null)
            {
                save = new ProfileGameSave
                {
                    ProfileId = profileId,
                    GameId = gameId,
                    GameFileId = gameFileId,
                    SystemName = normalizedSystemName,
                    CoreKey = normalizedCoreKey,
                    Kind = normalizedKind,
                    Key = normalizedKey,
                    FileName = normalizedFileName,
                    CreatedUtc = timestampUtc,
                    UpdatedUtc = timestampUtc
                };
                db.ProfileGameSaves.Add(save);
                await db.SaveChangesAsync(cancellationToken);
            }

            if (save.LatestRevision is not null
                && save.LatestRevision.SizeBytes == bytes.LongLength
                && string.Equals(save.LatestRevision.Sha256, sha256, StringComparison.OrdinalIgnoreCase))
            {
                await tx.CommitAsync(cancellationToken);
                return save.LatestRevision;
            }

            var storagePath = await storage.StoreRevisionAsync(
                () => new MemoryStream(bytes, writable: false),
                profileId,
                gameId,
                gameFileId,
                save.Id,
                timestampUtc,
                sha256[..8],
                Path.GetExtension(normalizedFileName),
                cancellationToken);

            var revision = new ProfileGameSaveRevision
            {
                ProfileGameSaveId = save.Id,
                RevisionTimestampUtc = timestampUtc,
                StoragePath = storagePath,
                SizeBytes = bytes.LongLength,
                Sha256 = sha256,
                Source = normalizedSource,
                OriginalUploadFileName = normalizedUploadFileName,
                CreatedUtc = timestampUtc
            };

            db.ProfileGameSaveRevisions.Add(revision);
            await db.SaveChangesAsync(cancellationToken);

            save.LatestRevisionId = revision.Id;
            save.LatestRevision = revision;
            save.SystemName = normalizedSystemName;
            save.CoreKey = normalizedCoreKey;
            save.UpdatedUtc = timestampUtc;
            await db.SaveChangesAsync(cancellationToken);

            await tx.CommitAsync(cancellationToken);
            return revision;
        }
        catch
        {
            await tx.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static async Task<byte[]> ReadAllBytesAsync(Stream content, CancellationToken cancellationToken)
    {
        if (content.CanSeek)
        {
            content.Position = 0;
        }

        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, cancellationToken);
        return ms.ToArray();
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

    private static string? NormalizeNullable(string? value)
    {
        value = (value ?? string.Empty).Trim();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}

public sealed record ProfileBatterySaveLatestRevision(
    string Key,
    string FileName,
    ProfileGameSaveRevision Revision);

public sealed record ProfileBatterySaveHistoryEntry(
    int RevisionId,
    int ProfileGameSaveId,
    int ProfileId,
    int GameId,
    int GameFileId,
    string Key,
    string FileName,
    string? CoreKey,
    string Kind,
    DateTime RevisionTimestampUtc,
    string StoragePath,
    long SizeBytes,
    string Sha256,
    string Source,
    string? OriginalUploadFileName,
    int? GamePlaySessionId,
    bool IsLatest);
