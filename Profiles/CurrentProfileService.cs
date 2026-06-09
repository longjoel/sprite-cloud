using System.Globalization;
using System.Security.Cryptography;
using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Profiles;

public sealed class CurrentProfileService
{
    private readonly AppDbContext db;
    private readonly IHttpContextAccessor httpContextAccessor;
    private readonly IDataProtector _protector;

    public const string CookieName = "gv.profile";
    public const string SessionCookieName = "gv.profile_session";
    public static readonly TimeSpan CookieLifetime = TimeSpan.FromDays(30);
    private const string ClearedRequestStateKey = "gv.current-profile.cleared";
    private const string RequestProfileIdKey = "gv.current-profile.id";
    private const string RequestSessionNonceKey = "gv.current-profile.session";
    private const string ProtectionPurpose = "GamesVault.Profile";

    public CurrentProfileService(AppDbContext db, IHttpContextAccessor httpContextAccessor, IDataProtectionProvider? dataProtection = null)
    {
        this.db = db;
        this.httpContextAccessor = httpContextAccessor;
        _protector = (dataProtection ?? DataProtectionProvider.Create("GamesVault"))
            .CreateProtector(ProtectionPurpose);
    }

    public async Task<UserProfile?> GetCurrentAsync(CancellationToken ct)
    {
        if (!TryGetCurrentProfileId(out var profileId))
        {
            return null;
        }

        return await db.UserProfiles
            .AsNoTracking()
            .Include(x => x.ParentProfile)
            .FirstOrDefaultAsync(x => x.Id == profileId && !x.IsArchived, ct);
    }

    public bool TryGetCurrentProfileId(out int profileId)
    {
        profileId = 0;
        var http = httpContextAccessor.HttpContext;
        if (http is null)
        {
            return false;
        }

        if (http.Items.TryGetValue(ClearedRequestStateKey, out var cleared) && cleared is true)
        {
            return false;
        }

        if (http.Items.TryGetValue(RequestProfileIdKey, out var overrideProfileId) && overrideProfileId is int requestProfileId)
        {
            profileId = requestProfileId;
            return true;
        }

        if (!http.Request.Cookies.TryGetValue(CookieName, out var raw))
        {
            return false;
        }

        // Try new protected format first, then fall back to legacy plaintext
        try
        {
            var unprotected = _protector.Unprotect(raw);
            return int.TryParse(unprotected, NumberStyles.Integer, CultureInfo.InvariantCulture, out profileId);
        }
        catch (CryptographicException)
        {
            // Legacy plaintext cookie — migrate silently
            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out profileId))
            {
                // Re-write with protection so next read uses the new format
                var nonce = GetCurrentSessionNonce();
                if (nonce is not null)
                {
                    WriteCurrentCookies(http, profileId, nonce);
                }
                return true;
            }
            return false;
        }
    }

    public string? GetCurrentSessionNonce()
    {
        var http = httpContextAccessor.HttpContext;
        if (http is null)
        {
            return null;
        }

        if (http.Items.TryGetValue(ClearedRequestStateKey, out var cleared) && cleared is true)
        {
            return null;
        }

        if (http.Items.TryGetValue(RequestSessionNonceKey, out var overrideSessionNonce) && overrideSessionNonce is string requestSessionNonce)
        {
            return string.IsNullOrWhiteSpace(requestSessionNonce) ? null : requestSessionNonce;
        }

        if (!http.Request.Cookies.TryGetValue(SessionCookieName, out var nonce))
        {
            return null;
        }

        return string.IsNullOrWhiteSpace(nonce) ? null : nonce.Trim();
    }

    public void SetCurrent(int profileId, string sessionNonce)
    {
        var http = httpContextAccessor.HttpContext ?? throw new InvalidOperationException("No active HTTP context.");

        http.Items[ClearedRequestStateKey] = false;
        http.Items[RequestProfileIdKey] = profileId;
        http.Items[RequestSessionNonceKey] = sessionNonce;
        WriteCurrentCookies(http, profileId, sessionNonce);
    }

    public void RefreshCurrent(int profileId, string sessionNonce)
    {
        var http = httpContextAccessor.HttpContext;
        if (http is null)
        {
            return;
        }

        if (http.Items.TryGetValue(ClearedRequestStateKey, out var cleared) && cleared is true)
        {
            return;
        }

        http.Items[RequestProfileIdKey] = profileId;
        http.Items[RequestSessionNonceKey] = sessionNonce;
        WriteCurrentCookies(http, profileId, sessionNonce);
    }

    public void ClearCurrent()
    {
        var http = httpContextAccessor.HttpContext;
        if (http is null)
        {
            return;
        }

        http.Items[ClearedRequestStateKey] = true;
        http.Items.Remove(RequestProfileIdKey);
        http.Items.Remove(RequestSessionNonceKey);
        http.Response.Cookies.Delete(CookieName);
        http.Response.Cookies.Delete(SessionCookieName);
    }

    private void WriteCurrentCookies(HttpContext http, int profileId, string sessionNonce)
    {
        var cookieOptions = new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            IsEssential = true,
            Secure = true,
            MaxAge = CookieLifetime,
            Expires = DateTimeOffset.UtcNow.Add(CookieLifetime)
        };

        var protectedId = _protector.Protect(profileId.ToString(CultureInfo.InvariantCulture));
        http.Response.Cookies.Append(CookieName, protectedId, cookieOptions);
        http.Response.Cookies.Append(SessionCookieName, sessionNonce, cookieOptions);
    }
}
