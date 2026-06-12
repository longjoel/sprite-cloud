using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public interface ITurnCredentialService
{
    TurnCredentials? GenerateCredentials(int ttlSeconds = 3600);
}

public sealed record TurnCredentials(
    string[] Urls,
    string Username,
    string Credential
);

public sealed class TurnCredentialService : ITurnCredentialService
{
    private readonly NosebleedOptions _options;

    public TurnCredentialService(IOptions<NosebleedOptions> options)
    {
        _options = options.Value ?? new NosebleedOptions();
    }

    public TurnCredentials? GenerateCredentials(int ttlSeconds = 3600)
    {
        if (string.IsNullOrWhiteSpace(_options.TurnSecret) ||
            string.IsNullOrWhiteSpace(_options.TurnHost))
        {
            return null;
        }

        // Build TURN URLs
        var urls = new List<string>
        {
            $"turns:{_options.TurnHost}:443?transport=tcp"
        };
        if (!_options.TurnHost.Contains(':'))
        {
            urls.Add($"turns:{_options.TurnHost}:5349?transport=tcp");
        }

        // Standard TURN REST API: username = {expiry}:{realm-userid}
        var expiry = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ttlSeconds;
        var username = $"{expiry}:nosebleed";
        var credential = GenerateHmacCredential(_options.TurnSecret, username);

        return new TurnCredentials(urls.ToArray(), username, credential);
    }

    private static string GenerateHmacCredential(string secret, string username)
    {
        var key = Encoding.UTF8.GetBytes(secret);
        var message = Encoding.UTF8.GetBytes(username);

        return Convert.ToBase64String(HMACsha1(key, message));
    }

    private static byte[] HMACsha1(byte[] key, byte[] message)
    {
#if NET5_0_OR_GREATER
        return HMACSHA1.HashData(key, message);
#else
        using var hmac = new HMACSHA1(key);
        return hmac.ComputeHash(message);
#endif
    }
}
