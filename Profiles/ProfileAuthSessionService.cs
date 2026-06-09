using System.Security.Cryptography;
using System.Text;
using games_vault.Data;
using games_vault.Models;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Profiles;

public sealed class ProfileAuthSessionService(
    AppDbContext db,
    IHttpContextAccessor httpContextAccessor)
{
    public async Task<ProfileAuthSession> CreateSessionAsync(int profileId, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var now = DateTime.UtcNow;
            var activeSessions = await db.ProfileAuthSessions
                .Where(x => x.ProfileId == profileId && x.RevokedUtc == null)
                .ToListAsync(ct);

            foreach (var session in activeSessions)
            {
                session.RevokedUtc = now;
                session.LastSeenUtc = now;
            }

            var authSession = new ProfileAuthSession
            {
                ProfileId = profileId,
                SessionNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
                UserAgentHash = HashUserAgent(httpContextAccessor.HttpContext?.Request.Headers.UserAgent.ToString()),
                LastSeenUtc = now
            };

            db.ProfileAuthSessions.Add(authSession);

            try
            {
                await db.SaveChangesAsync(ct);
                return authSession;
            }
            catch (DbUpdateException ex) when (attempt == 0 && IsUniqueConstraintViolation(ex))
            {
                db.ChangeTracker.Clear();
            }
        }

        throw new InvalidOperationException("Failed to create a single active auth session.");
    }

    /// <summary>
    /// Validates the session nonce and updates LastSeenUtc.
    /// Uses an atomic SQL UPDATE so concurrent requests don't race.
    /// Nonce is NOT rotated on every request — rotation happens only on
    /// login (CreateSessionAsync) where old sessions are revoked.
    /// </summary>
    public async Task<bool> ValidateSessionAsync(int profileId, string? sessionNonce, CancellationToken ct)
    {
        if (profileId <= 0 || string.IsNullOrWhiteSpace(sessionNonce))
        {
            return false;
        }

        var now = DateTime.UtcNow;

        // Atomic UPDATE — succeeds only if the current nonce still matches
        // (no race between read and write). Does not change the nonce value.
        try
        {
            var rows = await db.Database.ExecuteSqlRawAsync(
                """
                UPDATE ProfileAuthSessions
                SET LastSeenUtc = {0}
                WHERE ProfileId = {1} AND SessionNonce = {2} AND RevokedUtc IS NULL
                """,
                now, profileId, sessionNonce);

            return rows > 0;
        }
        catch
        {
            // Fallback for providers that don't support ExecuteSqlRaw (test in-memory).
            return await db.ProfileAuthSessions
                .AnyAsync(x => x.ProfileId == profileId && x.SessionNonce == sessionNonce && x.RevokedUtc == null, ct);
        }
    }

    private static bool IsUniqueConstraintViolation(DbUpdateException ex)
        => ex.InnerException is SqliteException sqlite && sqlite.SqliteErrorCode == 19;

    private static string? HashUserAgent(string? userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent))
        {
            return null;
        }

        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(userAgent.Trim()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
