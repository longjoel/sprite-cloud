using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.Cryptography.KeyDerivation;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using System.Security.Cryptography;

namespace games_vault.Profiles;

public sealed class LocalProfileService(AppDbContext db, CurrentProfileService currentProfile, ProfileInviteService? invites = null)
{
    public const string DefaultPin = "0000";

    public async Task<UserProfile> CreateAsync(string displayName, string? color, CancellationToken ct)
    {
        var profile = await BuildProfileAsync(displayName, color, ct);
        db.UserProfiles.Add(profile);
        await db.SaveChangesAsync(ct);
        currentProfile.SetCurrent(profile.Id);
        return profile;
    }

    public async Task<UserProfile> CreateWithInviteAsync(string displayName, string? color, string? inviteCode, CancellationToken ct)
    {
        if (invites is null)
        {
            throw new InvalidOperationException("Invite service is not configured.");
        }

        ProfileInviteService.NormalizeCode(inviteCode);
        var profile = await BuildProfileAsync(displayName, color, ct);
        db.UserProfiles.Add(profile);
        await db.SaveChangesAsync(ct);

        await invites.ConsumeAsync(inviteCode, profile.Id, ct);
        await db.SaveChangesAsync(ct);
        currentProfile.SetCurrent(profile.Id);
        return profile;
    }

    public async Task<bool> SignInAsync(int profileId, string? pin, CancellationToken ct)
    {
        if (!await VerifyPinAsync(profileId, pin, ct))
        {
            return false;
        }

        currentProfile.SetCurrent(profileId);
        return true;
    }

    public async Task<bool> VerifyPinAsync(int profileId, string? pin, CancellationToken ct)
    {
        var profile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == profileId && !x.IsArchived, ct);
        if (profile is null)
        {
            return false;
        }

        return VerifyPin(profile.PinHash, pin);
    }

    private async Task<UserProfile> BuildProfileAsync(string displayName, string? color, CancellationToken ct)
    {
        var normalizedName = PasskeyService.NormalizeDisplayName(displayName);
        var normalizedColor = PasskeyService.NormalizeColor(color);
        var now = DateTime.UtcNow;
        var isFirstProfile = !await db.UserProfiles.AnyAsync(ct);
        var userHandle = new byte[32];
        RandomNumberGenerator.Fill(userHandle);

        return new UserProfile
        {
            DisplayName = normalizedName,
            Color = normalizedColor,
            PasskeyUserHandleBase64Url = WebEncoders.Base64UrlEncode(userHandle),
            PinHash = HashPin(DefaultPin),
            IsAdmin = isFirstProfile,
            CreatedUtc = now,
            UpdatedUtc = now
        };
    }

    private static string HashPin(string pin)
    {
        var salt = new byte[16];
        RandomNumberGenerator.Fill(salt);
        var hash = KeyDerivation.Pbkdf2(pin, salt, KeyDerivationPrf.HMACSHA256, 100_000, 32);
        return $"pbkdf2-sha256$100000${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    private static bool VerifyPin(string? storedHash, string? suppliedPin)
    {
        var pin = (suppliedPin ?? "").Trim();
        if (pin.Length == 0)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(storedHash))
        {
            return pin == DefaultPin;
        }

        var parts = storedHash.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2-sha256" || !int.TryParse(parts[1], out var iterations))
        {
            return false;
        }

        var salt = Convert.FromBase64String(parts[2]);
        var expected = Convert.FromBase64String(parts[3]);
        var actual = KeyDerivation.Pbkdf2(pin, salt, KeyDerivationPrf.HMACSHA256, iterations, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
