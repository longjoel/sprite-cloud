using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace games_vault.Web;

public sealed class AdminOnlyFilter(CurrentAccessService currentAccess) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        if (await currentAccess.IsAdminAsync(context.HttpContext.RequestAborted))
        {
            await next();
            return;
        }

        if (context.Controller is Controller controller)
        {
            controller.TempData["Message"] = "Admin profile required to access this management area.";
            context.Result = controller.RedirectToAction("Index", "Profiles");
            return;
        }

        context.Result = new ForbidResult();
    }
}
