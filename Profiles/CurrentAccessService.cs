using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.DataProtection;
using System.Security.Cryptography;

namespace games_vault.Profiles;

public sealed class CurrentAccessService(
    CurrentProfileService currentProfile,
    IConfiguration configuration,
    IHttpContextAccessor httpContextAccessor,
    games_vault.Data.AppDbContext db,
    IDataProtectionProvider dataProtection)
{
    public const string AdminCookieName = "gv.admin";
    private readonly IDataProtector _adminCookieProtector = dataProtection.CreateProtector("GamesVault.AdminCookie");

    public async Task<AccessMode> GetAccessModeAsync(CancellationToken ct)
    {
        if (IsAdminOverrideEnabled())
        {
            return AccessMode.Admin;
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        if (profile is null || profile.IsEphemeral)
        {
            return AccessMode.Viewer;
        }

        return profile.IsAdmin ? AccessMode.Admin : AccessMode.Player;
    }

    public async Task<bool> IsAdminAsync(CancellationToken ct) => await GetAccessModeAsync(ct) == AccessMode.Admin;

    public async Task<bool> CanPlayAsync(CancellationToken ct)
    {
        var mode = await GetAccessModeAsync(ct);
        return mode is AccessMode.Player or AccessMode.Admin;
    }

    public async Task<bool> CanPlayRoomAsync(int roomId, CancellationToken ct)
    {
        if (await CanPlayAsync(ct))
        {
            return true;
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        if (profile is null || !profile.IsEphemeral)
        {
            return false;
        }

        return await db.ProfileShareLinks.AnyAsync(x =>
            x.RoomId == roomId &&
            x.RedeemedByProfileId == profile.Id &&
            x.GrantMode == games_vault.Models.RoomShareGrantMode.Player &&
            x.RevokedUtc == null &&
            x.UseCount > 0 &&
            x.ExpiresUtc > DateTime.UtcNow,
            ct);
    }

    public async Task<bool> CanPlaySessionAsync(string sessionId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        if (await CanPlayAsync(ct))
        {
            return true;
        }

        var roomId = await db.GamePlayRooms
            .AsNoTracking()
            .Where(x => x.NosebleedSessionId == sessionId && x.Status == games_vault.Models.GamePlayRoomStatus.Active)
            .Select(x => (int?)x.Id)
            .FirstOrDefaultAsync(ct);

        return roomId is int id && await CanPlayRoomAsync(id, ct);
    }

    public async Task<bool> CanChatAsync(CancellationToken ct)
    {
        if (IsAdminOverrideEnabled())
        {
            return false;
        }

        return await currentProfile.GetCurrentAsync(ct) is not null;
    }

    public async Task<bool> CanManageLibraryAsync(CancellationToken ct) => await IsAdminAsync(ct);

    private bool IsAdminOverrideEnabled()
    {
        if (configuration.GetValue("Access:AdminAlways", false))
        {
            return true;
        }

        var http = httpContextAccessor.HttpContext;
        if (http is null)
        {
            return false;
        }

        if (!http.Request.Cookies.TryGetValue(AdminCookieName, out var raw))
        {
            return false;
        }

        try
        {
            _adminCookieProtector.Unprotect(raw);
            return true;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }
}
