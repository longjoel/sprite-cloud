namespace games_vault.Tests;

public sealed class ProfileSignInRedirectMarkupTests
{
    [Fact]
    public void Password_Profile_SignIn_Redirects_To_Home()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var controller = File.ReadAllText(Path.Combine(repoRoot, "Controllers", "ProfilesController.cs")).Replace("\r\n", "\n");

        Assert.Contains("public async Task<IActionResult> SignIn(string username, string password, string? returnUrl", controller);
        Assert.Contains("return RedirectToLocalOrIndex(returnUrl);", controller);
        Assert.DoesNotContain("TempData[\"Message\"] = \"Profile selected.\";\n            return RedirectToAction(nameof(Index));", controller);
    }

    [Fact]
    public void Passkey_Login_Redirects_To_Home()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var controller = File.ReadAllText(Path.Combine(repoRoot, "Controllers", "PasskeysController.cs")).Replace("\r\n", "\n");
        var script = File.ReadAllText(Path.Combine(repoRoot, "wwwroot", "js", "passkeys.js")).Replace("\r\n", "\n");

        Assert.Contains("public async Task<ActionResult> CompleteLogin", controller);
        Assert.Contains("redirectUrl = Url.Action(\"Index\", \"Home\")", controller);
        Assert.DoesNotContain("CompleteLoginAsync(request, cancellationToken);\n            return Ok(new { profileId = profile.Id, displayName = profile.DisplayName, redirectUrl = Url.Action(\"Details\", \"Profiles\"", controller);
        Assert.Contains("const result = await postJson('/Passkeys/Login/Complete', payload);\n    window.location.href = result.redirectUrl || '/';", script);
    }
}
