using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.Cryptography.KeyDerivation;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace games_vault.Profiles;

public sealed class LocalProfileService(
    AppDbContext db,
    CurrentProfileService currentProfile,
    ProfileInviteService? invites = null,
    ProfileAuthSessionService? authSessions = null)
{
    private static readonly Regex UsernameRegex = new("^[a-z0-9._-]{3,32}$", RegexOptions.Compiled);

    public async Task<UserProfile> CreateAsync(string displayName, string username, string password, string? color, CancellationToken ct)
    {
        var profile = await BuildProfileAsync(displayName, username, password, color, ct);
        db.UserProfiles.Add(profile);
        await db.SaveChangesAsync(ct);
        var authSession = await CreateAuthSessionAsync(profile.Id, ct);
        currentProfile.SetCurrent(profile.Id, authSession.SessionNonce);
        return profile;
    }

    public async Task<UserProfile> CreateWithInviteAsync(string displayName, string username, string password, string? color, string? inviteCode, CancellationToken ct)
    {
        if (invites is null)
        {
            throw new InvalidOperationException("Invite service is not configured.");
        }

        ProfileInviteService.NormalizeCode(inviteCode);
        var profile = await BuildProfileAsync(displayName, username, password, color, ct);
        db.UserProfiles.Add(profile);
        await db.SaveChangesAsync(ct);

        await invites.ConsumeAsync(inviteCode, profile.Id, ct);
        await db.SaveChangesAsync(ct);
        var authSession = await CreateAuthSessionAsync(profile.Id, ct);
        currentProfile.SetCurrent(profile.Id, authSession.SessionNonce);
        return profile;
    }

    public async Task<UserProfile> CreateGuestChildAsync(int parentProfileId, string displayName, string? color, CancellationToken ct, int? createdFromShareLinkId = null)
    {
        var parent = await db.UserProfiles
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == parentProfileId && !x.IsArchived, ct)
            ?? throw new InvalidOperationException("Parent profile was not found.");

        var normalizedName = PasskeyService.NormalizeDisplayName(displayName);
        var normalizedColor = PasskeyService.NormalizeColor(color ?? parent.Color);
        var now = DateTime.UtcNow;
        var userHandle = new byte[32];
        RandomNumberGenerator.Fill(userHandle);

        var profile = new UserProfile
        {
            DisplayName = normalizedName,
            Color = normalizedColor,
            PasskeyUserHandleBase64Url = WebEncoders.Base64UrlEncode(userHandle),
            ParentProfileId = parent.Id,
            IsEphemeral = true,
            CreatedFromShareLinkId = createdFromShareLinkId,
            IsAdmin = false,
            CreatedUtc = now,
            UpdatedUtc = now
        };

        db.UserProfiles.Add(profile);
        await db.SaveChangesAsync(ct);
        var authSession = await CreateAuthSessionAsync(profile.Id, ct);
        currentProfile.SetCurrent(profile.Id, authSession.SessionNonce);
        return profile;
    }

    private const int MaxFailedAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    public async Task<bool> SignInAsync(string? username, string? password, CancellationToken ct)
    {
        var normalizedUsername = NormalizeUsername(username);
        var profile = await db.UserProfiles
            .FirstOrDefaultAsync(x => x.Username == normalizedUsername && !x.IsArchived, ct);
        if (profile is null)
        {
            return false;
        }

        // Check lockout
        if (profile.LoginLockoutUntilUtc.HasValue && profile.LoginLockoutUntilUtc.Value > DateTime.UtcNow)
        {
            return false;
        }

        if (!VerifyPassword(profile.PasswordHash, password))
        {
            // Track failed attempt
            profile.FailedLoginAttempts++;
            if (profile.FailedLoginAttempts >= MaxFailedAttempts)
            {
                profile.LoginLockoutUntilUtc = DateTime.UtcNow.Add(LockoutDuration);
                profile.FailedLoginAttempts = 0;
            }
            profile.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return false;
        }

        // Successful login — reset failed attempts
        if (profile.FailedLoginAttempts > 0 || profile.LoginLockoutUntilUtc.HasValue)
        {
            profile.FailedLoginAttempts = 0;
            profile.LoginLockoutUntilUtc = null;
            profile.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        var authSession = await CreateAuthSessionAsync(profile.Id, ct);
        currentProfile.SetCurrent(profile.Id, authSession.SessionNonce);
        return true;
    }

    public async Task<bool> ChangePasswordAsync(int profileId, string? currentPassword, string? newPassword, CancellationToken ct)
    {
        if (!await VerifyPasswordAsync(profileId, currentPassword, ct))
        {
            return false;
        }

        if (!IsValidPassword(newPassword))
        {
            return false;
        }

        var profile = await db.UserProfiles.FirstOrDefaultAsync(x => x.Id == profileId && !x.IsArchived, ct);
        if (profile is null)
        {
            return false;
        }

        profile.PasswordHash = HashPassword(newPassword!);
        profile.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> VerifyPasswordAsync(int profileId, string? password, CancellationToken ct)
    {
        var profile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == profileId && !x.IsArchived, ct);
        if (profile is null)
        {
            return false;
        }

        return VerifyPassword(profile.PasswordHash, password);
    }

    public static string NormalizeUsername(string? username)
    {
        var normalized = string.IsNullOrWhiteSpace(username)
            ? throw new ArgumentException("Username is required.", nameof(username))
            : username.Trim().ToLowerInvariant();

        if (!UsernameRegex.IsMatch(normalized))
        {
            throw new ArgumentException("Username must be 3-32 characters using only letters, numbers, periods, underscores, or hyphens.", nameof(username));
        }

        return normalized;
    }

    public static bool IsValidPassword(string? password)
        => !string.IsNullOrEmpty(password) && password.Length >= 8 && password.Length <= 256;

    private static bool HasSuppliedPassword(string? password)
        => !string.IsNullOrEmpty(password) && password.Length <= 256;

    private async Task<ProfileAuthSession> CreateAuthSessionAsync(int profileId, CancellationToken ct)
    {
        if (authSessions is not null)
        {
            return await authSessions.CreateSessionAsync(profileId, ct);
        }

        var now = DateTime.UtcNow;
        var existing = await db.ProfileAuthSessions
            .Where(x => x.ProfileId == profileId && x.RevokedUtc == null)
            .ToListAsync(ct);
        foreach (var session in existing)
        {
            session.RevokedUtc = now;
            session.LastSeenUtc = now;
        }

        var authSession = new ProfileAuthSession
        {
            ProfileId = profileId,
            SessionNonce = Guid.NewGuid().ToString("N"),
            LastSeenUtc = now
        };
        db.ProfileAuthSessions.Add(authSession);
        await db.SaveChangesAsync(ct);
        return authSession;
    }

    private async Task<UserProfile> BuildProfileAsync(string displayName, string username, string password, string? color, CancellationToken ct)
    {
        var normalizedName = PasskeyService.NormalizeDisplayName(displayName);
        var normalizedColor = PasskeyService.NormalizeColor(color);
        var normalizedUsername = NormalizeUsername(username);
        if (!IsValidPassword(password))
        {
            throw new ArgumentException("Password must be at least 8 characters.", nameof(password));
        }

        if (await db.UserProfiles.AnyAsync(x => x.Username == normalizedUsername, ct))
        {
            throw new InvalidOperationException("That username is already taken.");
        }

        var now = DateTime.UtcNow;
        var isFirstProfile = !await db.UserProfiles.AnyAsync(ct);
        var userHandle = new byte[32];
        RandomNumberGenerator.Fill(userHandle);

        return new UserProfile
        {
            DisplayName = normalizedName,
            Username = normalizedUsername,
            Color = normalizedColor,
            PasskeyUserHandleBase64Url = WebEncoders.Base64UrlEncode(userHandle),
            PasswordHash = HashPassword(password),
            IsAdmin = isFirstProfile,
            CreatedUtc = now,
            UpdatedUtc = now
        };
    }

    private static string HashPassword(string password)
    {
        var salt = new byte[16];
        RandomNumberGenerator.Fill(salt);
        var hash = KeyDerivation.Pbkdf2(password, salt, KeyDerivationPrf.HMACSHA256, 100_000, 32);
        return $"pbkdf2-sha256$100000${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    private static bool VerifyPassword(string? storedHash, string? suppliedPassword)
    {
        if (!HasSuppliedPassword(suppliedPassword) || string.IsNullOrWhiteSpace(storedHash))
        {
            return false;
        }

        var parts = storedHash.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2-sha256" || !int.TryParse(parts[1], out var iterations))
        {
            return false;
        }

        var salt = Convert.FromBase64String(parts[2]);
        var expected = Convert.FromBase64String(parts[3]);
        var actual = KeyDerivation.Pbkdf2(suppliedPassword!, salt, KeyDerivationPrf.HMACSHA256, iterations, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
