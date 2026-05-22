namespace games_vault.Profiles;

public sealed class CurrentAccessService(
    CurrentProfileService currentProfile,
    IConfiguration configuration,
    IHttpContextAccessor httpContextAccessor)
{
    public const string AdminCookieName = "gv.admin";

    public async Task<AccessMode> GetAccessModeAsync(CancellationToken ct)
    {
        if (IsAdminOverrideEnabled())
        {
            return AccessMode.Admin;
        }

        var profile = await currentProfile.GetCurrentAsync(ct);
        if (profile is null)
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

    public async Task<bool> CanManageLibraryAsync(CancellationToken ct) => await IsAdminAsync(ct);

    private bool IsAdminOverrideEnabled()
    {
        if (configuration.GetValue("Access:AdminAlways", false))
        {
            return true;
        }

        var http = httpContextAccessor.HttpContext;
        return http is not null
            && http.Request.Cookies.TryGetValue(AdminCookieName, out var raw)
            && string.Equals(raw, "1", StringComparison.Ordinal);
    }
}
