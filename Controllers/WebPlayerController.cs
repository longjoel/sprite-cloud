using games_vault.Models.ViewModels;
using games_vault.Web;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace games_vault.Controllers;

public sealed class WebPlayerController(
    IWebHostEnvironment env,
    WebPlayerAssetLocator locator,
    IOptions<WebPlayerOptions> options,
    ILogger<WebPlayerController> logger) : Controller
{
    [HttpGet]
    public IActionResult Index(
        string basePath,
        string? core,
        string? rom,
        string? romName,
        int? gameId,
        string? savesList,
        string? savesPut,
        string? csrf,
        CancellationToken cancellationToken = default)
    {
        basePath = string.IsNullOrWhiteSpace(basePath) ? "/webplayer" : basePath.TrimEnd('/');
        if (!basePath.StartsWith("/", StringComparison.Ordinal))
        {
            basePath = "/" + basePath;
        }

        Response.Headers.CacheControl = "no-store";

        return View(new WebPlayerPageViewModel
        {
            BasePath = basePath,
            Core = string.IsNullOrWhiteSpace(core) ? null : core.Trim(),
            RomUrl = string.IsNullOrWhiteSpace(rom) ? null : rom.Trim(),
            RomName = string.IsNullOrWhiteSpace(romName) ? null : romName.Trim(),
            GameId = gameId,
            SavesListUrl = string.IsNullOrWhiteSpace(savesList) ? null : savesList.Trim(),
            SavesPutUrl = string.IsNullOrWhiteSpace(savesPut) ? null : savesPut.Trim(),
            CsrfTokenUrl = string.IsNullOrWhiteSpace(csrf) ? null : csrf.Trim()
        });
    }

    [HttpGet]
    public IActionResult Patch()
    {
        var opts = options.Value ?? new WebPlayerOptions();
        if (!opts.Enabled)
        {
            return BadRequest("WebPlayer is disabled.");
        }

        if (string.IsNullOrWhiteSpace(env.WebRootPath))
        {
            return BadRequest("WebRootPath is not configured.");
        }

        var folder = Path.GetFullPath(Path.Combine(env.WebRootPath, locator.BaseFolderRelative));
        RetroArchWebPlayerPatch.ApplyToFolder(folder, logger);
        return Ok(new { patched = true, folder });
    }
}
