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
    /// Validates the session nonce, then rotates it (generates a new one).
    /// Uses an atomic SQL UPDATE so concurrent requests don't race.
    /// Returns (isValid, newNonce). A stolen nonce is only valid for one
    /// request/response cycle.
    /// </summary>
    public async Task<(bool Valid, string? NewNonce)> ValidateSessionAsync(int profileId, string? sessionNonce, CancellationToken ct)
    {
        if (profileId <= 0 || string.IsNullOrWhiteSpace(sessionNonce))
        {
            return (false, null);
        }

        var newNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var now = DateTime.UtcNow;

        // Try atomic SQL UPDATE first (works with real SQLite).
        // Fall back to read-then-write for in-memory test providers.
        try
        {
            var rows = await db.Database.ExecuteSqlRawAsync(
                """
                UPDATE ProfileAuthSessions
                SET SessionNonce = {0}, LastSeenUtc = {1}
                WHERE ProfileId = {2} AND SessionNonce = {3} AND RevokedUtc IS NULL
                """,
                newNonce, now, profileId, sessionNonce, ct);

            if (rows <= 0)
            {
                return (false, null);
            }

            return (true, newNonce);
        }
        catch (Exception) when (ct.IsCancellationRequested)
        {
            return (false, null);
        }
        catch
        {
            // Fallback for test providers that don't support ExecuteSqlRaw.
            var authSession = await db.ProfileAuthSessions
                .FirstOrDefaultAsync(x => x.ProfileId == profileId && x.SessionNonce == sessionNonce, ct);
            if (authSession is null || authSession.RevokedUtc is not null)
            {
                return (false, null);
            }

            authSession.SessionNonce = newNonce;
            authSession.LastSeenUtc = now;
            await db.SaveChangesAsync(ct);
            return (true, newNonce);
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
