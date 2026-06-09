using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Caching.Memory;

namespace games_vault.Web;

/// <summary>
/// Simple IP-based rate limiting action filter. Tracks request counts per IP
/// in a sliding window using IMemoryCache. Returns 429 when the limit is exceeded.
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = false)]
public sealed class RateLimitAttribute : Attribute, IAsyncActionFilter
{
    private readonly int _permitLimit;
    private readonly int _windowSeconds;

    public RateLimitAttribute(int permitLimit = 10, int windowSeconds = 60)
    {
        _permitLimit = permitLimit;
        _windowSeconds = windowSeconds;
    }

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var cache = context.HttpContext.RequestServices.GetRequiredService<IMemoryCache>();
        var ip = context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var cacheKey = $"ratelimit:{ip}:{context.HttpContext.Request.Path}";

        if (cache.TryGetValue<RateLimitState>(cacheKey, out var state) && state is not null)
        {
            if (state.Count >= _permitLimit)
            {
                context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
                context.HttpContext.Response.Headers["Retry-After"] = _windowSeconds.ToString();
                context.Result = new Microsoft.AspNetCore.Mvc.ObjectResult(new
                {
                    error = "Too many requests. Please try again later."
                })
                {
                    StatusCode = StatusCodes.Status429TooManyRequests
                };
                return;
            }

            state.Count++;
            cache.Set(cacheKey, state, state.ExpiresAt - DateTime.UtcNow);
        }
        else
        {
            cache.Set(cacheKey, new RateLimitState { Count = 1, ExpiresAt = DateTime.UtcNow.AddSeconds(_windowSeconds) },
                TimeSpan.FromSeconds(_windowSeconds));
        }

        await next();
    }

    private sealed record RateLimitState
    {
        public int Count { get; set; }
        public DateTime ExpiresAt { get; set; }
    }
}
