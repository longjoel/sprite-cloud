namespace games_vault.Profiles;

public sealed class ProfileSessionEnforcementMiddleware(
    RequestDelegate next,
    ILogger<ProfileSessionEnforcementMiddleware> logger)
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
        logger.LogDebug("Middleware: profileId={ProfileId}, nonce={Nonce}", profileId, sessionNonce?.Substring(0, Math.Min(8, sessionNonce?.Length ?? 0)));
        var isValid = await authSessions.ValidateSessionAsync(profileId, sessionNonce, context.RequestAborted);
        logger.LogDebug("Middleware: validation result={IsValid}", isValid);
        if (!isValid)
        {
            logger.LogWarning("Middleware: clearing profile {ProfileId} - nonce validation failed", profileId);
            currentProfile.ClearCurrent();
        }
        else if (!string.IsNullOrWhiteSpace(sessionNonce))
        {
            currentProfile.RefreshCurrent(profileId, sessionNonce);
        }

        await next(context);
    }
}
