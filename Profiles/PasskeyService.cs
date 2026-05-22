using Fido2NetLib;
using Fido2NetLib.Objects;
using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace games_vault.Profiles;

public sealed class PasskeyService(
    AppDbContext db,
    IMemoryCache cache,
    IHttpContextAccessor httpContextAccessor,
    CurrentProfileService currentProfile,
    IConfiguration configuration)
{
    private static readonly TimeSpan ChallengeTtl = TimeSpan.FromMinutes(5);

    public CredentialCreateOptions BeginRegistration(string displayName, string color, string? deviceName)
    {
        displayName = NormalizeDisplayName(displayName);
        color = NormalizeColor(color);
        var userHandle = RandomBytes(32);
        var user = new Fido2User
        {
            Name = displayName,
            DisplayName = displayName,
            Id = userHandle
        };

        var fido = CreateFido2();
        var options = fido.RequestNewCredential(new RequestNewCredentialParams
        {
            User = user,
            ExcludeCredentials = [],
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required,
                RequireResidentKey = true,
                UserVerification = UserVerificationRequirement.Preferred
            },
            AttestationPreference = AttestationConveyancePreference.None
        });

        cache.Set(RegistrationCacheKey(options.Challenge), new PendingRegistration(displayName, color, deviceName, WebEncoders.Base64UrlEncode(userHandle), options), ChallengeTtl);
        return options;
    }

    public async Task<UserProfile> CompleteRegistrationAsync(PasskeyAttestationDto dto, CancellationToken ct)
    {
        if (!cache.TryGetValue(RegistrationCacheKey(dto.Challenge), out PendingRegistration? pending) || pending is null)
        {
            throw new InvalidOperationException("Passkey registration challenge expired. Please try again.");
        }

        var response = new AuthenticatorAttestationRawResponse
        {
            Id = dto.Id,
            RawId = Decode(dto.RawId),
            Type = PublicKeyCredentialType.PublicKey,
            Response = new AuthenticatorAttestationRawResponse.AttestationResponse
            {
                AttestationObject = Decode(dto.Response.AttestationObject),
                ClientDataJson = Decode(dto.Response.ClientDataJson),
                Transports = ParseTransports(dto.Response.Transports)
            }
        };

        var fido = CreateFido2();
        var credential = await fido.MakeNewCredentialAsync(new MakeNewCredentialParams
        {
            AttestationResponse = response,
            OriginalOptions = pending.Options,
            IsCredentialIdUniqueToUserCallback = async (args, cancellationToken) =>
            {
                var credentialId = WebEncoders.Base64UrlEncode(args.CredentialId);
                return !await db.UserProfilePasskeys.AnyAsync(x => x.CredentialIdBase64Url == credentialId, cancellationToken);
            }
        }, ct);

        var now = DateTime.UtcNow;
        var isFirstProfile = !await db.UserProfiles.AnyAsync(ct);
        var profile = new UserProfile
        {
            DisplayName = pending.DisplayName,
            Color = pending.Color,
            PasskeyUserHandleBase64Url = pending.UserHandleBase64Url,
            IsAdmin = isFirstProfile,
            CreatedUtc = now,
            UpdatedUtc = now
        };
        db.UserProfiles.Add(profile);
        await db.SaveChangesAsync(ct);

        db.UserProfilePasskeys.Add(new UserProfilePasskey
        {
            ProfileId = profile.Id,
            CredentialIdBase64Url = WebEncoders.Base64UrlEncode(credential.Id),
            PublicKey = credential.PublicKey,
            UserHandleBase64Url = pending.UserHandleBase64Url,
            SignatureCounter = credential.SignCount,
            DeviceName = NormalizeNullable(pending.DeviceName, 200),
            CreatedUtc = now,
            LastUsedUtc = now
        });
        await db.SaveChangesAsync(ct);
        cache.Remove(RegistrationCacheKey(dto.Challenge));
        currentProfile.SetCurrent(profile.Id);
        return profile;
    }

    public AssertionOptions BeginLogin()
    {
        var fido = CreateFido2();
        var options = fido.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Preferred
        });
        cache.Set(LoginCacheKey(options.Challenge), options, ChallengeTtl);
        return options;
    }

    public async Task<UserProfile> CompleteLoginAsync(PasskeyAssertionDto dto, CancellationToken ct)
    {
        if (!cache.TryGetValue(LoginCacheKey(dto.Challenge), out AssertionOptions? options) || options is null)
        {
            throw new InvalidOperationException("Passkey sign-in challenge expired. Please try again.");
        }

        var credentialId = WebEncoders.Base64UrlEncode(Decode(dto.RawId));
        var stored = await db.UserProfilePasskeys.Include(x => x.Profile).FirstOrDefaultAsync(x => x.CredentialIdBase64Url == credentialId && !x.Profile.IsArchived, ct)
            ?? throw new InvalidOperationException("This passkey is not registered with Games Vault.");

        var response = new AuthenticatorAssertionRawResponse
        {
            Id = dto.Id,
            RawId = Decode(dto.RawId),
            Type = PublicKeyCredentialType.PublicKey,
            Response = new AuthenticatorAssertionRawResponse.AssertionResponse
            {
                AuthenticatorData = Decode(dto.Response.AuthenticatorData),
                ClientDataJson = Decode(dto.Response.ClientDataJson),
                Signature = Decode(dto.Response.Signature),
                UserHandle = string.IsNullOrWhiteSpace(dto.Response.UserHandle) ? null : Decode(dto.Response.UserHandle)
            }
        };

        var fido = CreateFido2();
        var result = await fido.MakeAssertionAsync(new MakeAssertionParams
        {
            AssertionResponse = response,
            OriginalOptions = options,
            StoredPublicKey = stored.PublicKey,
            StoredSignatureCounter = stored.SignatureCounter,
            IsUserHandleOwnerOfCredentialIdCallback = async (args, cancellationToken) =>
            {
                var handle = WebEncoders.Base64UrlEncode(args.UserHandle);
                var id = WebEncoders.Base64UrlEncode(args.CredentialId);
                return await db.UserProfilePasskeys.AnyAsync(x => x.UserHandleBase64Url == handle && x.CredentialIdBase64Url == id, cancellationToken);
            }
        }, ct);

        stored.SignatureCounter = result.SignCount;
        stored.LastUsedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        cache.Remove(LoginCacheKey(dto.Challenge));
        currentProfile.SetCurrent(stored.ProfileId);
        return stored.Profile;
    }

    public static string NormalizeDisplayName(string value)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? throw new ArgumentException("Display name is required.", nameof(value)) : value.Trim();
        return normalized.Length <= 80 ? normalized : normalized[..80];
    }

    public static string NormalizeColor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "#0d6efd";
        }

        var normalized = value.Trim();
        if (System.Text.RegularExpressions.Regex.IsMatch(normalized, "^#[0-9a-fA-F]{6}$"))
        {
            return normalized;
        }

        return "#0d6efd";
    }

    private Fido2 CreateFido2()
    {
        var request = httpContextAccessor.HttpContext?.Request;
        var host = request?.Host.Host ?? configuration["Passkeys:RpId"] ?? "localhost";
        var scheme = request?.Scheme ?? "https";
        var origin = request is null ? $"https://{host}" : $"{scheme}://{request.Host}";
        var rpId = configuration["Passkeys:RpId"] ?? host;
        return new Fido2(new Fido2Configuration
        {
            ServerDomain = rpId,
            ServerName = configuration["Passkeys:RpName"] ?? "Games Vault",
            Origins = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { origin }
        }, null);
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static byte[] Decode(string value) => WebEncoders.Base64UrlDecode(value);

    private static byte[] RandomBytes(int length)
    {
        var bytes = new byte[length];
        System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
        return bytes;
    }

    private static AuthenticatorTransport[]? ParseTransports(string[]? values)
    {
        if (values is null || values.Length == 0) return null;
        return values
            .Select(x => Enum.TryParse<AuthenticatorTransport>(x, ignoreCase: true, out var parsed) ? parsed : (AuthenticatorTransport?)null)
            .Where(x => x.HasValue)
            .Select(x => x!.Value)
            .ToArray();
    }

    private static string RegistrationCacheKey(byte[] challenge) => RegistrationCacheKey(WebEncoders.Base64UrlEncode(challenge));
    private static string RegistrationCacheKey(string challenge) => "passkey:register:" + challenge;
    private static string LoginCacheKey(byte[] challenge) => LoginCacheKey(WebEncoders.Base64UrlEncode(challenge));
    private static string LoginCacheKey(string challenge) => "passkey:login:" + challenge;

    private sealed record PendingRegistration(string DisplayName, string Color, string? DeviceName, string UserHandleBase64Url, CredentialCreateOptions Options);
}

public sealed record BeginPasskeyRegistrationRequest(string DisplayName, string? Color, string? DeviceName);

public sealed record PasskeyAttestationDto(string Id, string RawId, string Challenge, PasskeyAttestationResponseDto Response);

public sealed record PasskeyAttestationResponseDto(string AttestationObject, string ClientDataJson, string[]? Transports);

public sealed record PasskeyAssertionDto(string Id, string RawId, string Challenge, PasskeyAssertionResponseDto Response);

public sealed record PasskeyAssertionResponseDto(string AuthenticatorData, string ClientDataJson, string Signature, string? UserHandle);
