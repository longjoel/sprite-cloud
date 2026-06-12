using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Gameplay;

public sealed class GamePlayTelemetryService(AppDbContext db)
{
    public async Task<GamePlaySession> StartAsync(
        int gameId,
        int? fileId,
        string mode,
        string? externalSessionId,
        int? profileId,
        CancellationToken ct)
    {
        mode = Normalize(mode, 40);
        externalSessionId = NormalizeNullable(externalSessionId, 200);

        if (!string.IsNullOrWhiteSpace(externalSessionId))
        {
            var existing = await db.GamePlaySessions
                .Where(x => x.ExternalSessionId == externalSessionId && x.EndedUtc == null)
                .OrderByDescending(x => x.StartedUtc)
                .FirstOrDefaultAsync(ct);
            if (existing is not null)
            {
                existing.DurationSeconds = ComputeDurationSeconds(existing.StartedUtc, null, DateTime.UtcNow);
                if (existing.ProfileId is null && profileId is not null)
                {
                    existing.ProfileId = profileId;
                }
                await db.SaveChangesAsync(ct);
                return existing;
            }
        }

        var session = new GamePlaySession
        {
            GameId = gameId,
            GameFileId = fileId,
            Mode = mode,
            ExternalSessionId = externalSessionId,
            ProfileId = profileId,
            StartedUtc = DateTime.UtcNow,
            DurationSeconds = 0
        };
        db.GamePlaySessions.Add(session);
        await db.SaveChangesAsync(ct);
        return session;
    }

    public async Task<bool> FinishByExternalSessionAsync(string externalSessionId, string endReason, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(externalSessionId))
        {
            return false;
        }

        var session = await db.GamePlaySessions
            .Where(x => x.ExternalSessionId == externalSessionId && x.EndedUtc == null)
            .OrderByDescending(x => x.StartedUtc)
            .FirstOrDefaultAsync(ct);
        if (session is null)
        {
            return false;
        }

        var endedUtc = DateTime.UtcNow;
        session.EndedUtc = endedUtc;
        session.EndReason = NormalizeNullable(endReason, 100);
        session.DurationSeconds = ComputeDurationSeconds(session.StartedUtc, endedUtc, endedUtc);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<int> ReconcileActiveExternalSessionsAsync(
        string mode,
        IReadOnlySet<string> activeExternalSessionIds,
        string endReason,
        CancellationToken ct)
    {
        mode = Normalize(mode, 40);
        var activeIds = activeExternalSessionIds.Count == 0
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(activeExternalSessionIds.Where(x => !string.IsNullOrWhiteSpace(x)), StringComparer.OrdinalIgnoreCase);

        var sessions = await db.GamePlaySessions
            .Where(x => x.Mode == mode && x.EndedUtc == null && x.ExternalSessionId != null)
            .ToListAsync(ct);

        var endedUtc = DateTime.UtcNow;
        var reconciled = 0;
        foreach (var session in sessions)
        {
            if (session.ExternalSessionId is not null && activeIds.Contains(session.ExternalSessionId))
            {
                continue;
            }

            session.EndedUtc = endedUtc;
            session.EndReason = NormalizeNullable(endReason, 100);
            session.DurationSeconds = ComputeDurationSeconds(session.StartedUtc, endedUtc, endedUtc);
            reconciled++;
        }

        if (reconciled > 0)
        {
            await db.SaveChangesAsync(ct);
        }

        return reconciled;
    }

    public async Task<bool> TouchDurationAsync(string externalSessionId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(externalSessionId))
        {
            return false;
        }

        var now = DateTime.UtcNow;
        var session = await db.GamePlaySessions
            .Where(x => x.ExternalSessionId == externalSessionId && x.EndedUtc == null)
            .OrderByDescending(x => x.StartedUtc)
            .FirstOrDefaultAsync(ct);
        if (session is null)
        {
            return false;
        }

        session.DurationSeconds = ComputeDurationSeconds(session.StartedUtc, null, now);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<GamePlayDashboardStats> GetDashboardStatsAsync(int? profileId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var cutoff = now.AddDays(-90);
        var query = db.GamePlaySessions.AsNoTracking()
            .Where(x => x.StartedUtc >= cutoff);
        if (profileId is not null)
        {
            query = query.Where(x => x.ProfileId == profileId);
        }

        var stats = await query
            .GroupBy(x => x.Mode)
            .Select(g => new
            {
                Mode = g.Key,
                Count = g.Count(),
                ActiveCount = g.Count(x => x.EndedUtc == null)
            })
            .ToListAsync(ct);

        var totalCount = stats.Sum(x => x.Count);
        var totalActive = stats.Sum(x => x.ActiveCount);

        var byMode = stats
            .Select(x => new GamePlayModeStats(
                x.Mode,
                x.Count,
                x.ActiveCount,
                0))
            .OrderByDescending(x => x.TotalDurationSeconds)
            .ThenBy(x => x.Mode)
            .ToList();

        return new GamePlayDashboardStats(
            totalCount,
            totalActive,
            0,
            byMode);
    }

    private static int ComputeDurationSeconds(DateTime startedUtc, DateTime? endedUtc, DateTime nowUtc)
    {
        var end = endedUtc ?? nowUtc;
        var seconds = (int)Math.Max(0, Math.Round((end - startedUtc).TotalSeconds, MidpointRounding.AwayFromZero));
        return seconds;
    }

    private static string Normalize(string value, int maxLength)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "unknown" : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var normalized = value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }
}

public sealed record GamePlayDashboardStats(
    int TotalSessions,
    int ActiveSessions,
    int TotalDurationSeconds,
    IReadOnlyList<GamePlayModeStats> ByMode);

public sealed record GamePlayModeStats(
    string Mode,
    int TotalSessions,
    int ActiveSessions,
    int TotalDurationSeconds);
