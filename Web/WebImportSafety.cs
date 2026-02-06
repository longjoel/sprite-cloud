using System.Net;

namespace games_vault.Web;

public static class WebImportSafety
{
    public static Uri ParseAndValidateHttpUri(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            throw new InvalidOperationException("URL is required.");
        }

        url = url.Trim();

        // Be forgiving of unescaped spaces (common when copy/pasting filenames).
        if (url.Contains(' ', StringComparison.Ordinal))
        {
            url = url.Replace(" ", "%20", StringComparison.Ordinal);
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            throw new InvalidOperationException("Invalid URL.");
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("URL scheme must be http or https.");
        }

        if (!string.IsNullOrWhiteSpace(uri.UserInfo))
        {
            throw new InvalidOperationException("URL must not include credentials.");
        }

        if (!string.IsNullOrWhiteSpace(uri.Fragment))
        {
            throw new InvalidOperationException("URL must not include a fragment.");
        }

        if (string.IsNullOrWhiteSpace(uri.Host))
        {
            throw new InvalidOperationException("URL must include a host.");
        }

        return uri;
    }

    public static Uri EnsureTrailingSlash(Uri uri)
    {
        if (uri is null)
        {
            throw new ArgumentNullException(nameof(uri));
        }

        var s = uri.ToString();
        if (s.EndsWith("/", StringComparison.Ordinal))
        {
            return uri;
        }

        return new Uri(s + "/", UriKind.Absolute);
    }

    public static async Task EnsureSafeRemoteAsync(Uri uri, CancellationToken cancellationToken)
    {
        if (IPAddress.TryParse(uri.Host, out var ip))
        {
            if (IsBlockedIp(ip))
            {
                throw new InvalidOperationException("URL host is not allowed.");
            }

            return;
        }

        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(uri.Host, cancellationToken);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"Failed to resolve host '{uri.Host}': {ex.Message}");
        }

        if (addresses.Length == 0)
        {
            throw new InvalidOperationException($"Host '{uri.Host}' did not resolve to any IP addresses.");
        }

        foreach (var addr in addresses)
        {
            if (IsBlockedIp(addr))
            {
                throw new InvalidOperationException("URL host resolved to a blocked IP range.");
            }
        }
    }

    private static bool IsBlockedIp(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip))
        {
            return true;
        }

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var bytes = ip.GetAddressBytes();

            // 10.0.0.0/8
            if (bytes[0] == 10)
            {
                return true;
            }

            // 172.16.0.0/12
            if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
            {
                return true;
            }

            // 192.168.0.0/16
            if (bytes[0] == 192 && bytes[1] == 168)
            {
                return true;
            }

            // 169.254.0.0/16 (link-local)
            if (bytes[0] == 169 && bytes[1] == 254)
            {
                return true;
            }

            // 0.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8
            if (bytes[0] == 0 || bytes[0] == 127 || (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127))
            {
                return true;
            }

            // Multicast 224.0.0.0/4 and broadcast 255.255.255.255
            if (bytes[0] >= 224 || bytes[0] == 255)
            {
                return true;
            }
        }

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal || ip.IsIPv6Multicast || ip.IsIPv6SiteLocal)
            {
                return true;
            }

            // Unique local fc00::/7
            var bytes = ip.GetAddressBytes();
            if ((bytes[0] & 0xFE) == 0xFC)
            {
                return true;
            }
        }

        return false;
    }
}
