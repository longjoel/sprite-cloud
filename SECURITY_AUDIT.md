# 🔒 Games Vault — Security & Auth Audit Report

**Date:** 2026-06-12
**Scope:** `Controllers/*.cs`, `Profiles/*.cs`, `Web/*.cs`, `Program.cs`, `Views/*.cshtml`
**Excluded:** `tests/`, `bin/`, `obj/`, `publish/`, `node_modules/`, `wwwroot/lib/`

---

## [CRITICAL] Findings

### 1. Unauthenticated ROM File Download — No Authorization Check
**`Controllers/GamesController.cs:666-721`**

The `Rom(int id)` endpoint serves game ROMs via `PhysicalFile()` with **zero authorization**. Any visitor (including unauthenticated `AccessMode.Viewer` with no profile cookie) can enumerate game file IDs and download every stored or externally-linked ROM.

```csharp
[HttpGet]
public async Task<IActionResult> Rom(int id, CancellationToken cancellationToken = default)
{
    var file = await db.GameFiles.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id, ...);
    // ... resolves path ...
    return PhysicalFile(abs, "application/octet-stream", enableRangeProcessing: true);
}
```

No call to `currentAccess.IsAdminAsync()`, `CanPlayAsync()`, or even `CanPlayAsync()`. Contrast with `GameFilesController` (class-level `[AdminOnlyFilter]`) which properly protects its `Download` endpoint.

**Impact:** Full unauthorized access to the entire ROM library. Game file IDs are auto-increment integers, trivially enumerable.

**Mitigation:** Add `currentAccess.CanPlayAsync(cancellationToken)` check, or apply `[ServiceFilter(typeof(AdminOnlyFilter))]` to `GamesController` with `Rom` excluded.

### 2. Profile Session Cookie `Secure` Flag Conditional on `Request.IsHttps`
**`Profiles/CurrentProfileService.cs:169`**

```csharp
Secure = http.Request.IsHttps,
```

The `gv.profile` and `gv.profile_session` cookies (which together form the authentication token) are set **without the `Secure` flag** when the connection from the reverse proxy to Kestrel is plain HTTP. Per AGENTS.md, the app runs on `:8090` behind Nginx at `vault.local`. Unless `UseForwardedHeaders` is configured (it is NOT in `Program.cs`), Kestrel sees the proxy connection as HTTP and drops the `Secure` flag.

**Impact:** Auth cookies can be transmitted in cleartext on the proxy-to-app link. MITM on the local network between Nginx and Kestrel can steal profile sessions. The `HttpOnly=true` flag (line 166) provides partial defense, but combined with `SameSite=Lax` (line 167), the cookies will be sent on any same-site HTTP navigation.

**Mitigation:** Add `app.UseForwardedHeaders()` with `ForwardedHeaders.XForwardedProto` in `Program.cs` after `app.UseRouting()`, or hardcode `Secure = true` since the deployment model always terminates TLS at the reverse proxy.

---

## [HIGH] Findings

### 3. Open Redirect in `ProfilesController.SignIn` — Protocol-Relative URL Bypass
**`Controllers/ProfilesController.cs:130-137`**

```csharp
private static IActionResult RedirectToLocalOrIndex(string? returnUrl)
{
    if (!string.IsNullOrWhiteSpace(returnUrl) && Uri.TryCreate(returnUrl, UriKind.Relative, out var uri))
    {
        return new RedirectResult(returnUrl);  // BYPASS: //evil.com passes Uri.TryCreate
    }
    return new RedirectToActionResult("Index", "Home", null);
}
```

`Uri.TryCreate("//evil.com", UriKind.Relative, out _)` returns `true` in .NET, but `new RedirectResult("//evil.com")` issues a protocol-relative redirect that the browser resolves to `https://evil.com`. The proper check is `Url.IsLocalUrl(returnUrl)` as used in `ImportController.cs:302`.

This affects `ProfilesController.SignIn` (line 112), which calls `RedirectToLocalOrIndex(returnUrl)` on both success and failure paths (lines 117, 123, 127). An attacker can craft a link like:
```
https://vault.local/Profiles/SignIn?returnUrl=//evil.com
```
After sign-in (or on failure), the user is redirected to `evil.com`.

**Affected `returnUrl` sources in views that feed this endpoint:**
- `Views/Shared/_SignInModal.cshtml:12` — `@Context.Request.Path`
- `Views/Games/_GamesBank.cshtml:6` — `ViewData["ReturnUrl"]`
- `Views/Games/Index.cshtml:9` — `Context.Request.Path + Context.Request.QueryString`

Any form posting to `Profiles/SignIn` with a crafted `returnUrl` triggers this.

### 4. `games_vault_nosebleed_viewer` Cookie Missing `HttpOnly` — Three Sites
**`Controllers/SessionController.cs:640-646`**, **`Controllers/SessionController.cs:670-676`**, **`Controllers/ArcadeController.cs:615-621`**

```csharp
Response.Cookies.Append(NosebleedViewerCookieName, id, new CookieOptions
{
    Path = "/",
    MaxAge = TimeSpan.FromDays(30),
    SameSite = SameSiteMode.None,  // required for cross-origin WebSocket
    Secure = true
    // HttpOnly = true  ← MISSING
});
```

The Nosebleed viewer ID cookie is readable by JavaScript (`document.cookie`). Combined with `SameSite=None`, it's sent on all cross-origin requests. The viewer ID functions as a session token: it controls seat assignments, determines player/spectator status in WebSocket connections, and is used as the requester identity in `KickRoomPlayer` (line 164).

**Impact:** Any XSS in the application can exfiltrate viewer IDs, hijacking Nosebleed sessions. The CSP (`script-src 'self'`) limits third-party script injection, but `@Html.Raw()` patterns (see #13) or DOM-based injection could expose this.

**Mitigation:** Add `HttpOnly = true` to all three cookie creation sites. This may require adjusting the JavaScript that reads this cookie (if any exists).

### 5. Missing Rate Limiting on Profile Creation POST
**`Controllers/ProfilesController.cs:73-107`**

```csharp
[HttpPost]
[ValidateAntiForgeryToken]
// [RateLimit(...)]  ← MISSING
public async Task<IActionResult> Create(ProfileEditViewModel model, ...)
```

No IP-based rate limiting on profile creation. If an invite code is leaked (24-char base64url, 144 bits entropy — strong but social/sharing risk), an attacker can create unlimited profiles, each generating a new `ProfileAuthSession` row and cookie. Compare with `PasskeysController` which has `[RateLimit]` on all four auth-critical endpoints.

**Impact:** Account creation flooding once invite code is known. Database growth, session table bloat.

**Mitigation:** Add `[RateLimit(permitLimit: 3, windowSeconds: 60)]` on the POST Create method.

### 6. Share Link Redemption Endpoint Lacks IP Rate Limiting
**`Controllers/SessionController.cs:36-212` (PlayServer with `?share=` parameter)**

The `PlayServer` GET with `?share={sessionCode}` calls `shareLinkService.RedeemBySessionCodeAsync()` which internally rate-limits per-room guest creation (`MaxGuestCreationsPerRoomPerHour = 10`, `ProfileShareLinkService.cs:15`). However, an attacker can enumerate many rooms simultaneously, exhausting the cache-based rate limit per room while creating guests across the fleet. No IP-level throttle exists at the HTTP endpoint.

**Impact:** Distributed guest creation across multiple rooms can exceed per-room limits if many rooms have active share links.

**Mitigation:** Add `[RateLimit(permitLimit: 20, windowSeconds: 60)]` to the PlayServer endpoint, or move rate limiting into the `RedeemBySessionCodeAsync` call at an aggregate level.

### 7. `GameFilesController.Download` — External Path Served Without Containment Check
**`Controllers/GameFilesController.cs:72-74`**

```csharp
if (!string.IsNullOrWhiteSpace(file.ExternalPath))
{
    abs = file.ExternalPath;  // no path traversal validation
}
```

While `GameFilesController` is protected by `[AdminOnlyFilter]`, the `Download` method uses `file.ExternalPath` directly without any path containment check. Contrast with `RoomController.ResolveGameFileAbsolutePathAsync` (lines 211-246) which validates against allowed `LocalFolders` roots. If an admin (or an attacker who compromises admin credentials) stores a path like `/etc/passwd` as an external path, the file will be served.

**Impact:** Path traversal allowing file system read access beyond allowed folders, limited to admin-level actors.

**Mitigation:** Apply the same `LocalFolders` root-based validation used in `RoomController.ResolveGameFileAbsolutePathAsync`.

---

## [MEDIUM] Findings

### 8. `GamesController.Edit` (GET) — Exposes Edit Form to Unauthenticated Users
**`Controllers/GamesController.cs:861-872`**

```csharp
public async Task<IActionResult> Edit(int id)
{
    var game = await db.Games.Include(x => x.Files).FirstOrDefaultAsync(x => x.Id == id);
    // No authorization check
    return View(game);
}
```

The GET `Edit` endpoint shows the full game edit form with all metadata fields (name, system, genre, ratings) to any user, including unauthenticated viewers. The POST `Edit` correctly checks `IsAdminAsync()` (line 880), but exposing the form UI leaks internal metadata and suggests functionality that doesn't work for non-admins.

**Impact:** UI information disclosure. Users see admin-only UI elements. Low security impact, medium UX concern.

### 9. `HomeController` Preview Endpoints — Session Enumeration via Responses
**`Controllers/HomeController.cs:181-280`**

`NosebleedPreviewVideo` (line 181) and `NosebleedPreviewStream` (line 226) accept any `sessionId` and return distinct status codes: 404 (session not found/exited) vs 502 (Nosebleed unavailable). An attacker can enumerate session IDs to discover active game sessions. The preview endpoints also bypass room visibility — anyone can view snapshots of any active session without being a room participant.

**Impact:** Active session discovery, privacy leak of play activity. Streamable preview frames of private game sessions.

### 10. `RoomController.RoomPresence` (GET) — Returns Viewer IDs to Any Caller
**`Controllers/RoomController.cs:100-128`**

```csharp
return Json(new
{
    players = snapshot.Players.Select(x => new { displayName = ..., playerNumber = ..., port = ..., viewerId = x.ViewerId }),
    ...
});
```

The GET `RoomPresence` endpoint requires no authentication and returns `viewerId` values for all active participants. Combined with the viewer cookie lacking `HttpOnly` (#4), this creates a complete hijack chain: enumerate viewer IDs via presence API, read the viewer cookie via XSS, impersonate any viewer.

**Impact:** Real-time player list with session identifiers exposed to any caller.

### 11. `SessionController.KeepAliveServerSession` — No CSRF Protection
**`Controllers/SessionController.cs:231-278`**

```csharp
[HttpPost("/Games/KeepAliveServerSession")]
// [ValidateAntiForgeryToken]  ← MISSING
public async Task<IActionResult> KeepAliveServerSession(string sessionId, ...)
```

This POST endpoint lacks `[ValidateAntiForgeryToken]`. While the viewer ID must come from a cookie (blocking pure CSRF), the endpoint modifies seat assignments (`nosebleedSeats.Assign`) and writes participant records. A malicious page could force a user to continuously poll this endpoint, artificially inflating session statistics.

**Impact:** Seat assignment pollution, inflated play duration tracking.

### 12. `SessionController.NosebleedWebRtcSession` — No CSRF Protection
**`Controllers/SessionController.cs:415-515`**

```csharp
[HttpPost("/Games/NosebleedWebRtcSession")]
// [ValidateAntiForgeryToken]  ← MISSING
public async Task<IActionResult> NosebleedWebRtcSession(string sessionId, ...)
```

This endpoint proxies WebRTC offers between browsers and Nosebleed. It has origin validation (`IsAllowedWebSocketOrigin`) but no CSRF token. Since WebRTC requires the actual browser to initiate the connection, practical CSRF impact is limited, but the endpoint processes request bodies and could be used as an SSRF relay.

**Impact:** Low — origin checking provides defense, but no anti-forgery token.

### 13. `SessionController.LeaveServerSession` — Deletes Cookie and Releases Seats
**`Controllers/SessionController.cs:517-538`**

```csharp
[HttpPost]
[ValidateAntiForgeryToken]
public async Task<IActionResult> LeaveServerSession(string sessionId, string? returnUrl = null)
{
    if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var viewerId))
    {
        nosebleedSeats.Release(sessionId, viewerId);
        await roomService.DisconnectRoomParticipantSessionAsync(sessionId, viewerId, ...);
    }
    Response.Cookies.Delete(NosebleedViewerCookieName);
    ...
}
```

Takes arbitrary `sessionId` without verifying the viewer actually has a seat in that session. While the `Release` operation likely no-ops for unknown session+viewerId pairs, it could be abused to enumerate which sessions a viewer is in (or force disconnects across sessions). Also uses `LocalRedirect(returnUrl)` with proper `Url.IsLocalUrl` check (line 532—533) — this is **correct**.

**Impact:** Potential cross-session viewer ID enumeration.

### 14. `ProfileBatterySavesController` — Consistent Not-Found Responses Enable Revision Enumeration
**`Controllers/ProfileBatterySavesController.cs:180-184, 247-249`**

```csharp
if (revision is null) { return NotFound(); }  // returns same for "doesn't exist" and "not yours"
```

The `Download` and `LoadAndReset` endpoints return 404 for both "revision doesn't exist" and "revision belongs to another profile." While this is a correct IDOR defense (no information leakage), the `revisionId` parameter is an auto-increment integer, and the endpoint behavior is identical, so enumeration is possible in both cases. **Not exploitable** — the response is uniform.

**Impact:** None — correct IDOR protection. Included for completeness.

### 15. `AdminOnlyFilter` — Applies Per-Controller, Not Globally
**`Web/AdminOnlyFilter.cs:1-26`**

The filter is applied selectively via `[ServiceFilter(typeof(AdminOnlyFilter))]` on `AdminController`, `ImportController`, `SystemFilesController`, `GameFilesController`, and specific actions in `ProfilesController`. There is no global catch-all policy. A new controller added without the attribute is fully accessible by default. The profile session middleware (`ProfileSessionEnforcementMiddleware`) only validates cookie integrity, not authorization level.

**Impact:** Defense-in-depth gap. New endpoints default to open access.

### 16. `CurrentAccessService.AdminCookie` — Read-Only Elevation Mechanism
**`Profiles/CurrentAccessService.cs:14-15, 114-136`**

The `gv.admin` cookie is checked via Data Protection decryption to grant `AccessMode.Admin`. However:
1. This cookie is **never written** by any code in this codebase (searched exhaustively)
2. It appears to be an external/admin-managed mechanism
3. If set, it bypasses all profile-based auth checks

If this cookie is set by an external auth proxy or hand-placed by an admin, it functions correctly. But the mechanism is invisible in code, creating a surprise elevation path for auditors.

**Impact:** Hidden admin elevation mechanism with no visibility in the auth flow.

---

## [LOW] Findings

### 17. `@Html.Raw()` in `PlayServer.cshtml` — Fragile But Currently Safe
**`Views/Games/PlayServer.cshtml:52-84`**

```cshtml
<script type="application/json" id="nosebleed-player-config">
@Html.Raw(System.Text.Json.JsonSerializer.Serialize(new { ... }))
</script>
```

The `@Html.Raw()` is inside a `<script type="application/json">` block (not executable JavaScript), and all values are server-generated from `Url.Action()` and model properties. `System.Text.Json` properly escapes special characters. The `touchLayoutName` variable (line 68) is derived from `systemName` (a database `Game` property, not user input). Battery save diagnostic messages may contain user-uploaded filenames, but `System.Text.Json` escapes `</` and control characters.

**Verdict:** Currently safe, but fragile. If a future developer adds user-controlled data to this JSON block without sanitization, XSS becomes possible despite the `application/json` type (browsers have historically had MIME type confusion vulnerabilities).

### 18. `_InviteLinks.cshtml` — `GeneratedShareLink` in HTML Attribute
**`Views/Games/_InviteLinks.cshtml:18`**

```cshtml
<input ... value="@Model.GeneratedShareLink" readonly ... />
```

`GeneratedShareLink` is populated from `TempData["GeneratedShareLink"]` set by `RoomController.CreateRoomShareLink` (line 95-96), built from `Url.RouteUrl(..., Request.Scheme)` which produces a safe absolute URL. Razor auto-encodes `@` expressions in attribute context for `"`, `<`, `&`. Safe.

**Verdict:** Safe. No vulnerability.

### 19. `SystemFilesController.ImportPack` — `Path.GetTempPath()` Staging
**`Controllers/SystemFilesController.cs:253`**

```csharp
var stagingRoot = Path.Combine(Path.GetTempPath(), "gv-system-pack", Guid.NewGuid().ToString("N"));
```

Uses system temp directory (`/tmp` on Linux) for ZIP extraction staging. AGENTS.md explicitly warns against `/tmp` usage. Cleanup is `try/finally`, but process crashes could leave stale files. Not a security vulnerability, but a deployment hygiene concern.

### 20. `CurrentProfileService` — Legacy Plaintext Cookie Fallback
**`Profiles/CurrentProfileService.cs:76-89`**

```csharp
catch (CryptographicException)
{
    // Legacy plaintext cookie — migrate silently
    if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out profileId))
    {
        WriteCurrentCookies(http, profileId, nonce);
        return true;
    }
}
```

Silently accepts and upgrades legacy plaintext cookies. If a plaintext profile ID was ever intercepted before Data Protection was added, that cookie remains valid indefinitely. The grace period should eventually be removed.

### 21. `PasskeyService.CreateFido2` — Origin Derived from Request Host Header
**`Profiles/PasskeyService.cs:197-209`**

```csharp
var origin = request is null ? $"https://{host}" : $"{scheme}://{request.Host}";
```

The FIDO2 origin is constructed from the request's `Host` header. If host header filtering is misconfigured, an attacker could spoof the origin, potentially causing WebAuthn ceremonies to fail or be routed to a different RP ID. Mitigated by ASP.NET Core's default host filtering middleware, which is active unless explicitly disabled.

### 22. `RateLimitAttribute` — IP-Based, Shared Behind NAT/Proxy
**`Web/RateLimitAttribute.cs:25-26`**

```csharp
var ip = context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
```

The rate limiter uses the raw TCP connection IP. Behind a reverse proxy (documented Nginx), all requests appear from the proxy's IP unless `UseForwardedHeaders` is configured. This means rate limits apply collectively to all users rather than per-user, effectively disabling rate limiting in the standard deployment model.

**Impact:** Rate limiting may not work as intended in production. Requires forwarded header configuration.

### 23. `LocalProfileService` — Password Policy: 8+ Chars, No Complexity
**`Profiles/LocalProfileService.cs:178`**

```csharp
public static bool IsValidPassword(string? password)
    => !string.IsNullOrEmpty(password) && password.Length >= 8 && password.Length <= 256;
```

Minimum 8 characters, maximum 256, no complexity requirements. This is intentional for a home/retro gaming app but worth noting.

**Impact:** Weak passwords accepted. Brute-force protection via 5-attempt lockout (lines 81-82) and `[RateLimit]` on the SignIn endpoint provide partial mitigation.

### 24. `_SignInModal.cshtml` — `returnUrl` from `Context.Request.Path`
**`Views/Shared/_SignInModal.cshtml:12`**

```cshtml
<input type="hidden" name="returnUrl" value="@Context.Request.Path" />
```

The path is auto-HTML-encoded by the Razor engine. However, the value flows into `ProfilesController.SignIn` which has the open redirect bypass (#3). An attacker who can manipulate `Request.Path` (e.g., via URL rewriting misconfiguration) could inject a malicious `returnUrl`.

**Impact:** Low — requires combined exploitation with URL rewriting or reverse proxy misconfiguration.

### 25. `SessionController.ResolveViewerIdFromRequest` — Accepts Viewer ID from Query String
**`Controllers/SessionController.cs:659-662`**

```csharp
var fallbackViewerId = Request.Headers["X-Nosebleed-Viewer"].FirstOrDefault();
if (string.IsNullOrWhiteSpace(fallbackViewerId))
{
    fallbackViewerId = Request.Query["viewerId"].FirstOrDefault();
}
```

Accepts a viewer ID from the `viewerId` query string parameter. While validated via `Guid.TryParse`, this means a viewer ID in a URL (e.g., shared link, log) could be used to adopt someone else's session identity. The resulting cookie replaces any existing viewer cookie.

**Impact:** Viewer ID leakage via URL sharing. A user who shares a URL containing `?viewerId=...` exposes their session identity.

### 26. `Program.cs` — No Forwarded Headers Configuration
**`Program.cs:173-177`**

```csharp
app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseWebSockets();
app.UseRouting();
```

There is no `app.UseForwardedHeaders()` call, meaning `Request.IsHttps` and `Connection.RemoteIpAddress` are based on the direct connection to Kestrel, not the original client connection through the Nginx reverse proxy. This directly causes finding #2 (missing Secure cookie flag) and finding #22 (shared IP rate limiting).

### 27. `LocalProfileService.CreateAuthSessionAsync` — Fallback Uses `Guid.NewGuid()` When `authSessions` Is Null
**`Profiles/LocalProfileService.cs:183-209`**

When `authSessions` is null (constructor default), the method falls back to a `Guid.NewGuid().ToString("N")` nonce instead of the cryptographically random bytes used by `ProfileAuthSessionService` (line 32: `RandomNumberGenerator.GetBytes(16)`). GUIDs are not cryptographically random — they contain predictable version bits. While unlikely to be exploitable in practice, this is a weaker nonce source.

**Impact:** Low — requires `authSessions` to be null, which never happens in the registered DI configuration (line 72 of Program.cs).

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| **CRITICAL** | 2 | Unauthenticated ROM download; Cookie Secure flag missing behind proxy |
| **HIGH** | 5 | Open redirect bypass; Viewer cookie missing HttpOnly (3 sites); Missing rate limits on profile creation and share redemption; External path traversal in files download |
| **MEDIUM** | 8 | Edit form exposure; Session enumeration via preview; Presence API leaks viewer IDs; Missing CSRF on keep-alive/WebRTC; Per-controller (not global) admin filter; Hidden admin cookie mechanism |
| **LOW** | 11 | Html.Raw fragility; Temp path usage; Legacy cookie fallback; Password policy; Query-string viewer ID; Missing forwarded headers; Guid nonce fallback |

### Top 5 Remediation Priorities

1. **Add authorization check to `GamesController.Rom`** (`Controllers/GamesController.cs:666`) — add `CanPlay` or admin check before serving ROM bytes.
2. **Fix the open redirect in `ProfilesController.RedirectToLocalOrIndex`** (`Controllers/ProfilesController.cs:132`) — replace `Uri.TryCreate(..., UriKind.Relative, ...)` with `Url.IsLocalUrl(returnUrl)`.
3. **Add `HttpOnly = true` to `games_vault_nosebleed_viewer` cookie** — in all three creation sites: `SessionController.cs:640`, `SessionController.cs:670`, `ArcadeController.cs:615`.
4. **Add `[RateLimit]` to `ProfilesController.Create` POST** (`Controllers/ProfilesController.cs:73`) — mitigate invite code abuse.
5. **Configure `app.UseForwardedHeaders()` in `Program.cs`** — enable proper `Request.IsHttps` and client IP detection behind Nginx.
