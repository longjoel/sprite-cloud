namespace games_vault.Tests;

public sealed class RoomShareLinkAjaxMarkupTests
{
    [Fact]
    public void CreateRoomShareLink_Returns_Json_For_Ajax_And_Retains_Form_Fallback()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var controller = File.ReadAllText(Path.Combine(repoRoot, "Controllers", "RoomController.cs")).Replace("\r\n", "\n");

        Assert.Contains("public async Task<IActionResult> CreateRoomShareLink", controller);
        Assert.Contains("var shareLink = Url.RouteUrl(", controller);
        Assert.Contains("if (IsAjaxRequest())", controller);
        Assert.Contains("return Json(new { link = shareLink, grantMode = grantModeLabel });", controller);
        Assert.Contains("TempData[\"GeneratedShareLink\"] = shareLink;", controller);
        Assert.Contains("return RedirectToRoute(\"PlayServerRoom\", new { id = room.GameId, code = room.Code });", controller);
        Assert.Contains("Request.Headers[\"X-Requested-With\"]", controller);
        Assert.Contains("Request.Headers.Accept.Any", controller);
    }
}
