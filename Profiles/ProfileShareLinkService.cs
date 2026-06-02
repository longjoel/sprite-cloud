using System.Security.Cryptography;
using System.Text;
using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Profiles;

public sealed class ProfileShareLinkService(AppDbContext db, LocalProfileService localProfiles)
{
    private static readonly TimeSpan DefaultLifetime = TimeSpan.FromHours(12);

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
}

public sealed record ProfileShareLinkCreateResult(string RawToken, ProfileShareLink ShareLink);
public sealed record ProfileShareLinkRedeemResult(ProfileShareLink ShareLink, UserProfile Profile);
