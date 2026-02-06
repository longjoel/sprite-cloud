namespace games_vault.NetworkShares;

public sealed record SmbLocation(string Host, string Share, string SubPath)
{
    public string ShareUncPath => $"\\\\{Host}\\{Share}";
}

public static class SmbUri
{
    public static bool IsSmbUri(string path) =>
        path.StartsWith("smb://", StringComparison.OrdinalIgnoreCase);

    public static SmbLocation Parse(string smbUri)
    {
        if (!Uri.TryCreate(smbUri, UriKind.Absolute, out var uri) || !string.Equals(uri.Scheme, "smb", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Invalid SMB URI. Use smb://server/share/path.");
        }

        var host = uri.Host;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (string.IsNullOrWhiteSpace(host) || segments.Length == 0)
        {
            throw new InvalidOperationException("SMB URI must include server and share (smb://server/share).");
        }

        var share = segments[0];
        var subPath = segments.Length > 1 ? string.Join('/', segments.Skip(1)) : "";

        return new SmbLocation(host, share, subPath);
    }

    public static string Combine(string smbRootUri, string relativePath)
    {
        smbRootUri = smbRootUri.TrimEnd('/');
        relativePath = relativePath.TrimStart('/');
        return string.IsNullOrEmpty(relativePath) ? smbRootUri : $"{smbRootUri}/{relativePath}";
    }

    public static string GetRelativePath(string smbRootUri, string smbFullUri)
    {
        smbRootUri = smbRootUri.TrimEnd('/');
        smbFullUri = smbFullUri.Trim();

        if (string.Equals(smbFullUri, smbRootUri, StringComparison.OrdinalIgnoreCase))
        {
            return "";
        }

        if (!smbFullUri.StartsWith(smbRootUri + "/", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("File path is not within the configured share root.");
        }

        return smbFullUri[(smbRootUri.Length + 1)..];
    }
}

