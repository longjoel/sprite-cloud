using System.Globalization;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Profiles;

public sealed class CurrentProfileService(AppDbContext db, IHttpContextAccessor httpContextAccessor)
{
    public const string CookieName = "gv.profile";

    public async Task<UserProfile?> GetCurrentAsync(CancellationToken ct)
    {
        var http = httpContextAccessor.HttpContext;
        if (http is null || !http.Request.Cookies.TryGetValue(CookieName, out var raw))
        {
            return null;
        }

        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var profileId))
        {
            return null;
        }

        return await db.UserProfiles
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == profileId && !x.IsArchived, ct);
    }

    public void SetCurrent(int profileId)
    {
        var http = httpContextAccessor.HttpContext ?? throw new InvalidOperationException("No active HTTP context.");
        http.Response.Cookies.Append(CookieName, profileId.ToString(CultureInfo.InvariantCulture), new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            IsEssential = true,
            Expires = DateTimeOffset.UtcNow.AddYears(1)
        });
    }

    public void ClearCurrent()
    {
        httpContextAccessor.HttpContext?.Response.Cookies.Delete(CookieName);
    }
}
