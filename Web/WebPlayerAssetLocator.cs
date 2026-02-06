using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Options;

namespace games_vault.Web;

public sealed class WebPlayerAssetLocator(IWebHostEnvironment env, IOptions<WebPlayerOptions> options)
{
    private readonly WebPlayerOptions _options = options.Value ?? new WebPlayerOptions();

    public string BasePath
    {
        get
        {
            var basePath = string.IsNullOrWhiteSpace(_options.BasePath) ? "/webplayer" : _options.BasePath.TrimEnd('/');
            if (!basePath.StartsWith("/", StringComparison.Ordinal))
            {
                basePath = "/" + basePath;
            }
            return basePath;
        }
    }

    public string BaseFolderRelative => BasePath.TrimStart('/');

    public string? WebRootPath => env.WebRootPath;

    public bool IsInstalled()
    {
        if (string.IsNullOrWhiteSpace(env.WebRootPath))
        {
            return false;
        }

        var root = Path.GetFullPath(env.WebRootPath);
        var indexPath = Path.Combine(root, BaseFolderRelative, "index.html");
        return File.Exists(indexPath);
    }
}
