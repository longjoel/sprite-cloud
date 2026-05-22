using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;

namespace games_vault.Controllers;

[ApiController]
[Route("Passkeys")]
public sealed class PasskeysController(PasskeyService passkeys, CurrentProfileService currentProfile) : ControllerBase
{
    [HttpPost("Register/Options")]
    public ActionResult BeginRegistration([FromBody] BeginPasskeyRegistrationRequest request)
    {
        try
        {
            var options = passkeys.BeginRegistration(request.DisplayName, request.Color ?? "#0d6efd", request.DeviceName);
            return Ok(options);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("Register/Complete")]
    public async Task<ActionResult> CompleteRegistration([FromBody] PasskeyAttestationDto request, CancellationToken cancellationToken)
    {
        try
        {
            var profile = await passkeys.CompleteRegistrationAsync(request, cancellationToken);
            return Ok(new { profileId = profile.Id, displayName = profile.DisplayName, redirectUrl = Url.Action("Details", "Profiles", new { id = profile.Id }) });
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Fido2NetLib.Fido2VerificationException)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("Login/Options")]
    public ActionResult BeginLogin()
    {
        var options = passkeys.BeginLogin();
        return Ok(options);
    }

    [HttpPost("Login/Complete")]
    public async Task<ActionResult> CompleteLogin([FromBody] PasskeyAssertionDto request, CancellationToken cancellationToken)
    {
        try
        {
            var profile = await passkeys.CompleteLoginAsync(request, cancellationToken);
            return Ok(new { profileId = profile.Id, displayName = profile.DisplayName, redirectUrl = Url.Action("Details", "Profiles", new { id = profile.Id }) });
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Fido2NetLib.Fido2VerificationException)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("Logout")]
    [ValidateAntiForgeryToken]
    public IActionResult Logout()
    {
        currentProfile.ClearCurrent();
        return RedirectToAction("Index", "Profiles");
    }
}
