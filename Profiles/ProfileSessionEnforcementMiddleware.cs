namespace games_vault.Profiles;

public sealed class ProfileSessionEnforcementMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(
        HttpContext context,
        CurrentProfileService currentProfile,
        ProfileAuthSessionService authSessions)
    {
        if (!currentProfile.TryGetCurrentProfileId(out var profileId))
        {
            await next(context);
            return;
        }

        var sessionNonce = currentProfile.GetCurrentSessionNonce();
        var isValid = await authSessions.ValidateSessionAsync(profileId, sessionNonce, context.RequestAborted);
        if (!isValid)
        {
            currentProfile.ClearCurrent();
        }
        else if (!string.IsNullOrWhiteSpace(sessionNonce))
        {
            currentProfile.RefreshCurrent(profileId, sessionNonce);
        }

        await next(context);
    }
}
