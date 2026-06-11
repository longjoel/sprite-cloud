using System.Security.Cryptography;
using System.Text;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Npgsql;

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
    /// Uses a standard read-then-write approach.
    /// </summary>
    public async Task<bool> ValidateSessionAsync(int profileId, string? sessionNonce, CancellationToken ct)
    {
        if (profileId <= 0 || string.IsNullOrWhiteSpace(sessionNonce))
        {
            return false;
        }

        var authSession = await db.ProfileAuthSessions
            .FirstOrDefaultAsync(x => x.ProfileId == profileId && x.SessionNonce == sessionNonce, ct);
        if (authSession is null || authSession.RevokedUtc is not null)
        {
            return false;
        }

        authSession.LastSeenUtc = DateTime.UtcNow;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Another request updated this session concurrently — the write we
            // attempted is lost, but the session is still valid. Return true.
        }
        return true;
    }

    private static bool IsUniqueConstraintViolation(DbUpdateException ex)
        => ex.InnerException is PostgresException pg && pg.SqlState == PostgresErrorCodes.UniqueViolation;

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
