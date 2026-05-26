using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedTicketSigner(IOptions<NosebleedOptions> options, ILogger<NosebleedTicketSigner> logger)
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();

    public string? CreatePlayerToken(string matchId, string playerId, int port = 0)
    {
        if (!_options.RequireAuth)
        {
            return null;
        }

        return CreateToken(matchId, playerId, "player", new[] { port });
    }

    public string? CreateSpectatorToken(string matchId, string viewerId)
    {
        if (!_options.RequireAuth)
        {
            return null;
        }

        return CreateToken(matchId, viewerId, "spectator", Array.Empty<int>());
    }

    private string CreateToken(string matchId, string playerId, string role, IReadOnlyCollection<int> allowedPorts)
    {
        var secret = GetOrCreateSecret();
        var now = DateTimeOffset.UtcNow;
        var payload = new
        {
            match_id = matchId,
            player_id = playerId,
            role,
            allowed_ports = allowedPorts,
            exp_unix_ms = now.AddMinutes(Math.Max(1, _options.TicketTtlMinutes)).ToUnixTimeMilliseconds(),
            iat_unix_ms = now.ToUnixTimeMilliseconds()
        };

        var json = JsonSerializer.Serialize(payload);
        var payloadBytes = Encoding.UTF8.GetBytes(json);
        using var hmac = new HMACSHA256(secret);
        var signature = hmac.ComputeHash(payloadBytes);
        return $"v1.{Base64Url(payloadBytes)}.{Base64Url(signature)}";
    }

    private byte[] GetOrCreateSecret()
    {
        var path = _options.AuthSecretPath;
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Nosebleed auth is enabled but AuthSecretPath is not configured.");
        }

        if (File.Exists(path))
        {
            var existing = File.ReadAllText(path).Trim();
            if (!string.IsNullOrWhiteSpace(existing))
            {
                return Encoding.UTF8.GetBytes(existing);
            }
        }

        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var bytes = RandomNumberGenerator.GetBytes(32);
        var secret = Convert.ToBase64String(bytes);
        File.WriteAllText(path, secret + Environment.NewLine, Encoding.UTF8);
        try
        {
            if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not set restrictive mode on Nosebleed auth secret {Path}", path);
        }

        return Encoding.UTF8.GetBytes(secret);
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes)
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');
}
