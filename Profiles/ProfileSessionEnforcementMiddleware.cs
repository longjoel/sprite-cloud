namespace games_vault.Profiles;

public sealed class ProfileSessionEnforcementMiddleware(
    RequestDelegate next,
    CurrentProfileService currentProfile,
    ProfileAuthSessionService authSessions)
{
    public async Task InvokeAsync(HttpContext context)
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

        await next(context);
    }
}
