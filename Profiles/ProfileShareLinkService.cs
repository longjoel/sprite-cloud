using System.Security.Cryptography;
using System.Text;
using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace games_vault.Profiles;

public sealed class ProfileShareLinkService(AppDbContext db, LocalProfileService localProfiles, IMemoryCache cache)
{
    private static readonly TimeSpan DefaultLifetime = TimeSpan.FromHours(12);
    private static readonly TimeSpan RedeemSessionLifetime = TimeSpan.FromHours(1);
    private const int MaxGuestCreationsPerRoomPerHour = 10;

    private void CheckGuestCreationRateLimit(int roomId)
    {
        var cacheKey = $"guest-creation-rate:{roomId}";
        var count = cache.GetOrCreate(cacheKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1);
            entry.SlidingExpiration = TimeSpan.FromMinutes(10);
            return 0;
        });

        if (count >= MaxGuestCreationsPerRoomPerHour)
        {
            throw new InvalidOperationException("Too many guest profiles created for this room in the last hour. Please try again later.");
        }

        cache.Set(cacheKey, count + 1, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1),
            SlidingExpiration = TimeSpan.FromMinutes(10)
        });
    }

    public async Task<ProfileShareLinkCreateResult> CreateAsync(int roomId, int createdByProfileId, RoomShareGrantMode grantMode, CancellationToken ct)
    {
        var room = await db.GamePlayRooms
            .AsNoTracking()
            .Include(x => x.Game)
            .FirstOrDefaultAsync(x => x.Id == roomId && x.Status == GamePlayRoomStatus.Active, ct)
            ?? throw new InvalidOperationException("Room not found.");

        var creator = await db.UserProfiles
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == createdByProfileId && !x.IsArchived, ct)
            ?? throw new InvalidOperationException("Profile not found.");

        var rawToken = GenerateRawToken();
        var now = DateTime.UtcNow;
        var shareLink = new ProfileShareLink
        {
            TokenHash = HashToken(rawToken),
            RoomId = room.Id,
            GameId = room.GameId,
            CreatedByProfileId = creator.Id,
            ParentProfileId = creator.Id,
            GrantMode = grantMode,
            MaxUses = 1,
            UseCount = 0,
            CreatedUtc = now,
            ExpiresUtc = now.Add(DefaultLifetime)
        };

        db.ProfileShareLinks.Add(shareLink);
        await db.SaveChangesAsync(ct);
        return new ProfileShareLinkCreateResult(rawToken, shareLink);
    }

    public async Task<ProfileShareLinkRedeemResult> RedeemAsync(string rawToken, CancellationToken ct)
    {
        var tokenHash = HashToken(rawToken);
        var shareLink = await db.ProfileShareLinks
            .Include(x => x.Room)
            .Include(x => x.ParentProfile)
            .FirstOrDefaultAsync(x => x.TokenHash == tokenHash, ct)
            ?? throw new InvalidOperationException("Share link was not found.");

        if (shareLink.RevokedUtc is not null)
        {
            throw new InvalidOperationException("That share link has been revoked.");
        }

        if (shareLink.ExpiresUtc <= DateTime.UtcNow)
        {
            throw new InvalidOperationException("That share link has expired.");
        }

        if (shareLink.UseCount >= shareLink.MaxUses)
        {
            throw new InvalidOperationException("That share link has already been used.");
        }

        if (shareLink.Room.Status != GamePlayRoomStatus.Active)
        {
            throw new InvalidOperationException("That room is no longer active.");
        }

        var parent = shareLink.ParentProfile;
        if (parent is null || parent.IsArchived)
        {
            throw new InvalidOperationException("Parent profile was not found.");
        }

        CheckGuestCreationRateLimit(shareLink.RoomId);

        var guestDisplayName = BuildGuestDisplayName(parent.DisplayName);
        var guest = await localProfiles.CreateGuestChildAsync(parent.Id, guestDisplayName, parent.Color, ct, shareLink.Id);

        shareLink.UseCount++;
        shareLink.LastUsedUtc = DateTime.UtcNow;
        shareLink.RedeemedByProfileId = guest.Id;
        await db.SaveChangesAsync(ct);

        return new ProfileShareLinkRedeemResult(shareLink, guest);
    }

    public static string HashToken(string rawToken)
    {
        if (string.IsNullOrWhiteSpace(rawToken))
        {
            throw new InvalidOperationException("Share token is required.");
        }

        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(rawToken.Trim()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string GenerateRawToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(24);
        return WebEncoders.Base64UrlEncode(bytes);
    }

    private static string BuildGuestDisplayName(string? parentDisplayName)
    {
        var owner = string.IsNullOrWhiteSpace(parentDisplayName)
            ? "player"
            : parentDisplayName.Trim();
        return $"Guest of {owner}";
    }

    /// <summary>
    /// Creates a short-lived, single-use redeem session that maps a URL-safe
    /// session code to an existing ProfileShareLink. The session code (not the
    /// raw token) goes in the share URL, preventing token leakage via referer
    /// headers, access logs, and browser history.
    /// </summary>
    public async Task<string> CreateRedeemSessionAsync(int shareLinkId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var sessionCode = GenerateSessionCode();
        var session = new ProfileShareRedeemSession
        {
            ProfileShareLinkId = shareLinkId,
            SessionCode = sessionCode,
            CreatedUtc = now,
            ExpiresUtc = now.Add(RedeemSessionLifetime)
        };

        db.ProfileShareRedeemSessions.Add(session);
        await db.SaveChangesAsync(ct);
        return sessionCode;
    }

    /// <summary>
    /// Redeems a share link by session code (the short code from the URL)
    /// rather than by raw token. The session is consumed on first use.
    /// </summary>
    public async Task<ProfileShareLinkRedeemResult> RedeemBySessionCodeAsync(string sessionCode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sessionCode))
        {
            throw new InvalidOperationException("Session code is required.");
        }

        var session = await db.ProfileShareRedeemSessions
            .Include(s => s.ShareLink)
                .ThenInclude(sl => sl.Room)
            .Include(s => s.ShareLink)
                .ThenInclude(sl => sl.ParentProfile)
            .FirstOrDefaultAsync(s => s.SessionCode == sessionCode.Trim(), ct)
            ?? throw new InvalidOperationException("Share session was not found.");

        if (session.IsConsumed)
        {
            throw new InvalidOperationException("That share session has already been used.");
        }

        if (session.IsExpired)
        {
            throw new InvalidOperationException("That share session has expired.");
        }

        var shareLink = session.ShareLink;

        if (shareLink.RevokedUtc is not null)
        {
            throw new InvalidOperationException("That share link has been revoked.");
        }

        if (shareLink.ExpiresUtc <= DateTime.UtcNow)
        {
            throw new InvalidOperationException("That share link has expired.");
        }

        if (shareLink.UseCount >= shareLink.MaxUses)
        {
            throw new InvalidOperationException("That share link has already been used.");
        }

        if (shareLink.Room.Status != GamePlayRoomStatus.Active)
        {
            throw new InvalidOperationException("That room is no longer active.");
        }

        var parent = shareLink.ParentProfile;
        if (parent is null || parent.IsArchived)
        {
            throw new InvalidOperationException("Parent profile was not found.");
        }

        CheckGuestCreationRateLimit(shareLink.RoomId);

        var guestDisplayName = BuildGuestDisplayName(parent.DisplayName);
        var guest = await localProfiles.CreateGuestChildAsync(parent.Id, guestDisplayName, parent.Color, ct, shareLink.Id);

        session.ConsumedUtc = DateTime.UtcNow;
        shareLink.UseCount++;
        shareLink.LastUsedUtc = DateTime.UtcNow;
        shareLink.RedeemedByProfileId = guest.Id;
        await db.SaveChangesAsync(ct);

        return new ProfileShareLinkRedeemResult(shareLink, guest);
    }

    private static string GenerateSessionCode()
    {
        var bytes = RandomNumberGenerator.GetBytes(16);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

public sealed record ProfileShareLinkCreateResult(string RawToken, ProfileShareLink ShareLink);
public sealed record ProfileShareLinkRedeemResult(ProfileShareLink ShareLink, UserProfile Profile);
