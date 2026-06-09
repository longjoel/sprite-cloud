using Microsoft.AspNetCore.DataProtection;

namespace games_vault.NetworkShares;

/// <summary>
/// Protects sensitive values (e.g. network share passwords) at rest using
/// ASP.NET Core Data Protection. Backward-compatible with plaintext values:
/// if a value doesn't look encrypted it is returned as-is.
/// </summary>
public sealed class PasswordProtector
{
    private readonly IDataProtector _protector;
    private const string Purpose = "GamesVault.NetworkShare.Password";
    private const string EncryptedPrefix = "CfDJ8"; // ASP.NET Core Data Protection B64 prefix

    public PasswordProtector(IDataProtectionProvider provider)
    {
        _protector = provider.CreateProtector(Purpose);
    }

    /// <summary>Encrypt a plaintext value for storage.</summary>
    public string Protect(string? plaintext)
    {
        if (string.IsNullOrEmpty(plaintext))
            return string.Empty;

        // Don't double-encrypt
        if (plaintext.StartsWith(EncryptedPrefix, StringComparison.Ordinal))
            return plaintext;

        return _protector.Protect(plaintext);
    }

    /// <summary>Decrypt a stored value. Returns plaintext as-is if not encrypted (backward compat).</summary>
    public string Unprotect(string? ciphertext)
    {
        if (string.IsNullOrEmpty(ciphertext))
            return string.Empty;

        // Backward compat: if it doesn't look encrypted, return as-is
        if (!ciphertext.StartsWith(EncryptedPrefix, StringComparison.Ordinal))
            return ciphertext;

        try
        {
            return _protector.Unprotect(ciphertext);
        }
        catch
        {
            // If decryption fails, return as-is for backward compatibility
            return ciphertext;
        }
    }
}
