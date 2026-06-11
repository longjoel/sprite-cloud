using games_vault.Data;
using games_vault.Models;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace games_vault.Tests;

public sealed class ProfileSessionEnforcementMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_ClearsProfileCookiesWhenNonceHasBeenRevoked()
    {
        await using var fixture = await CreateFixtureAsync();
        var profile = new UserProfile
        {
            DisplayName = "Joel",
            Username = "joel",
            Color = "#198754",
            PasskeyUserHandleBase64Url = "handle",
            PasswordHash = "hash",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        fixture.Db.UserProfiles.Add(profile);
        await fixture.Db.SaveChangesAsync();

        fixture.Db.ProfileAuthSessions.Add(new ProfileAuthSession
        {
            ProfileId = profile.Id,
            SessionNonce = "revoked-session",
            LastSeenUtc = DateTime.UtcNow,
            RevokedUtc = DateTime.UtcNow
        });
        await fixture.Db.SaveChangesAsync();

        fixture.HttpContext.Request.Headers.Cookie =
            $"{CurrentProfileService.CookieName}={profile.Id}; {CurrentProfileService.SessionCookieName}=revoked-session";

        var middleware = new ProfileSessionEnforcementMiddleware(_ => Task.CompletedTask, NullLogger<ProfileSessionEnforcementMiddleware>.Instance);

        await middleware.InvokeAsync(
            fixture.HttpContext,
            new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor),
            new ProfileAuthSessionService(fixture.Db, fixture.HttpContextAccessor));

        var setCookie = fixture.HttpContext.Response.Headers.SetCookie.ToString();
        Assert.Contains(CurrentProfileService.CookieName, setCookie);
        Assert.Contains(CurrentProfileService.SessionCookieName, setCookie);
    }

    [Fact]
    public async Task InvokeAsync_PreventsRevokedSessionFromRemainingAuthenticatedForCurrentRequest()
    {
        await using var fixture = await CreateFixtureAsync();
        var profile = new UserProfile
        {
            DisplayName = "Joel",
            Username = "joel",
            Color = "#198754",
            PasskeyUserHandleBase64Url = "handle",
            PasswordHash = "hash",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        fixture.Db.UserProfiles.Add(profile);
        await fixture.Db.SaveChangesAsync();

        fixture.Db.ProfileAuthSessions.Add(new ProfileAuthSession
        {
            ProfileId = profile.Id,
            SessionNonce = "revoked-session",
            LastSeenUtc = DateTime.UtcNow,
            RevokedUtc = DateTime.UtcNow
        });
        await fixture.Db.SaveChangesAsync();

        fixture.HttpContext.Request.Headers.Cookie =
            $"{CurrentProfileService.CookieName}={profile.Id}; {CurrentProfileService.SessionCookieName}=revoked-session";

        UserProfile? profileSeenDownstream = null;
        var middleware = new ProfileSessionEnforcementMiddleware(async _ =>
        {
            var downstreamCurrent = new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor);
            profileSeenDownstream = await downstreamCurrent.GetCurrentAsync(CancellationToken.None);
        }, NullLogger<ProfileSessionEnforcementMiddleware>.Instance);

        await middleware.InvokeAsync(
            fixture.HttpContext,
            new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor),
            new ProfileAuthSessionService(fixture.Db, fixture.HttpContextAccessor));

        Assert.Null(profileSeenDownstream);
    }

    [Fact]
    public async Task InvokeAsync_RefreshesPersistentCookiesWhenSessionIsValid()
    {
        await using var fixture = await CreateFixtureAsync();
        var profile = new UserProfile
        {
            DisplayName = "Joel",
            Username = "joel",
            Color = "#198754",
            PasskeyUserHandleBase64Url = "handle",
            PasswordHash = "hash",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        fixture.Db.UserProfiles.Add(profile);
        await fixture.Db.SaveChangesAsync();

        fixture.Db.ProfileAuthSessions.Add(new ProfileAuthSession
        {
            ProfileId = profile.Id,
            SessionNonce = "valid-session",
            LastSeenUtc = DateTime.UtcNow
        });
        await fixture.Db.SaveChangesAsync();

        fixture.HttpContext.Request.Headers.Cookie =
            $"{CurrentProfileService.CookieName}={profile.Id}; {CurrentProfileService.SessionCookieName}=valid-session";

        var middleware = new ProfileSessionEnforcementMiddleware(_ => Task.CompletedTask, NullLogger<ProfileSessionEnforcementMiddleware>.Instance);

        await middleware.InvokeAsync(
            fixture.HttpContext,
            new CurrentProfileService(fixture.Db, fixture.HttpContextAccessor),
            new ProfileAuthSessionService(fixture.Db, fixture.HttpContextAccessor));

        var setCookie = fixture.HttpContext.Response.Headers.SetCookie.ToString();
        Assert.Contains(CurrentProfileService.CookieName, setCookie);
        Assert.Contains($"{CurrentProfileService.SessionCookieName}=valid-session", setCookie);
        Assert.Contains("expires=", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("max-age=2592000", setCookie, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var scope = await TestDbFixture.CreateScopeAsync();
        var db = scope.Db;
        var httpContext = new DefaultHttpContext();
        var accessor = new TestHttpContextAccessor(httpContext);
        return new TestFixture(scope, db, httpContext, accessor);
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed record TestFixture(TestDbFixture.Scope Scope, AppDbContext Db, DefaultHttpContext HttpContext, IHttpContextAccessor HttpContextAccessor) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Scope.DisposeAsync();
        }
    }
}
