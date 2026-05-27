using System.Globalization;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Profiles;

public sealed class CurrentProfileService(AppDbContext db, IHttpContextAccessor httpContextAccessor)
{
    public const string CookieName = "gv.profile";
    public const string SessionCookieName = "gv.profile_session";
    private const string ClearedRequestStateKey = "gv.current-profile.cleared";
    private const string RequestProfileIdKey = "gv.current-profile.id";
    private const string RequestSessionNonceKey = "gv.current-profile.session";

    public async Task<UserProfile?> GetCurrentAsync(CancellationToken ct)
    {
        if (!TryGetCurrentProfileId(out var profileId))
        {
            return null;
        }

        return await db.UserProfiles
            .AsNoTracking()
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

        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out profileId);
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
        var cookieOptions = new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            IsEssential = true,
            Expires = DateTimeOffset.UtcNow.AddYears(1)
        };

        http.Items[ClearedRequestStateKey] = false;
        http.Items[RequestProfileIdKey] = profileId;
        http.Items[RequestSessionNonceKey] = sessionNonce;
        http.Response.Cookies.Append(CookieName, profileId.ToString(CultureInfo.InvariantCulture), cookieOptions);
        http.Response.Cookies.Append(SessionCookieName, sessionNonce, cookieOptions);
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
}
