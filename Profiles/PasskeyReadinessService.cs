namespace games_vault.Profiles;

public sealed class PasskeyReadinessService(IHttpContextAccessor httpContextAccessor)
{
    public PasskeyReadiness GetCurrent()
    {
        var request = httpContextAccessor.HttpContext?.Request;
        if (request is null)
        {
            return new PasskeyReadiness(false, "No active request is available.");
        }

        var host = request.Host.Host;
        var secure = request.IsHttps || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase) || string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase);
        return secure
            ? new PasskeyReadiness(true, null)
            : new PasskeyReadiness(false, "Passkeys usually require HTTPS or localhost. Use a stable HTTPS hostname for VAULT before relying on passkeys from other devices.");
    }
}

public sealed record PasskeyReadiness(bool IsReady, string? Warning);
