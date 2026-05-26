using Microsoft.AspNetCore.Mvc.Filters;

namespace games_vault.Profiles;

public sealed class CurrentProfileViewDataFilter(CurrentProfileService currentProfile, CurrentAccessService currentAccess) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        if (context.Controller is Microsoft.AspNetCore.Mvc.Controller controller)
        {
            var ct = context.HttpContext.RequestAborted;
            var profile = await currentProfile.GetCurrentAsync(ct);
            var accessMode = await currentAccess.GetAccessModeAsync(ct);
            controller.ViewData["CurrentProfileName"] = profile?.DisplayName;
            controller.ViewData["CurrentProfileId"] = profile?.Id;
            controller.ViewData["AccessMode"] = accessMode.ToString();
            controller.ViewData["CanPlay"] = accessMode is AccessMode.Player or AccessMode.Admin;
            controller.ViewData["CanManageLibrary"] = accessMode is AccessMode.Admin;
        }

        await next();
    }
}
