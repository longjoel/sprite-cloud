# Docker & Container Readiness — 12-Point Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Games Vault shippable as a Docker appliance with PostgreSQL, graceful lifecycle, and production-ready defaults.

**Architecture:** .NET 10 ASP.NET Core web app + PostgreSQL + Nosebleed (GStreamer media server). Multi-stage Docker build, docker-compose orchestration, env-var-driven configuration. SQLite → PostgreSQL migration with fresh EF migrations.

**Tech Stack:** .NET 10, PostgreSQL 16, EF Core 10, Npgsql, Docker, docker-compose, Testcontainers, Serilog

---

## Current State (what exists now)

- No Dockerfile, no docker-compose, no `.dockerignore`
- SQLite only; 22 EF migrations (SQLite-specific), 53 test files all using `SqliteConnection("Data Source=:memory:")`
- Zero structured logging; 31 `ILogger` calls total, all default-format
- One `BackgroundService` (`ArcadeCabinetSupervisor`) — iterates every 15s, no shutdown cleanup
- Data Protection keys are ephemeral (in-memory, regenerated on restart)
- Session state (Nosebleed processes, seats, relay metrics) is entirely in-memory with no startup reconciliation
- `Access:AdminAlways` config key exists and can be accidentally enabled
- No health check endpoint
- Configuration is file-based via `appsettings.json`; some env var overrides work via ASP.NET defaults but not all paths are env-configurable
- CSP is strict (`unsafe-inline` needed for Razor views, which is normal)
- Nosebleed binary expected at `/opt/nosebleed/nosebleed`; cores at configured `CoreRoot`

## The Plan

---

### Task 1: Add structured logging with Serilog

**Objective:** Replace default Microsoft logging with Serilog, output JSON to stdout for Docker log drivers.

**Files:**
- Modify: `games-vault.csproj`
- Modify: `Program.cs` (top of file + logging registration)
- Create: `appsettings.json` — add Serilog config section

**Step 1:** Add packages

```xml
<PackageReference Include="Serilog.AspNetCore" Version="9.0.*" />
<PackageReference Include="Serilog.Sinks.Console" Version="6.*" />
```

**Step 2:** In `Program.cs`, replace `WebApplication.CreateBuilder(args)` with Serilog bootstrap:

```csharp
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console(formatter: new Serilog.Formatting.Json.JsonFormatter())
    .CreateLogger();

builder.Host.UseSerilog();
```

**Step 3:** Add Serilog config to `appsettings.json`:

```json
"Serilog": {
  "MinimumLevel": {
    "Default": "Information",
    "Override": {
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore": "Warning"
    }
  }
}
```

**Step 4:** Remove old `"Logging"` section from `appsettings.json` (Serilog replaces it).

**Verification:** `dotnet run` — logs appear as JSON on stdout. Hit a page, confirm structured output.

---

### Task 2: Migrate SQLite → PostgreSQL

**Objective:** Swap the database provider from SQLite to PostgreSQL with fresh migrations.

**Files:**
- Modify: `games-vault.csproj`
- Modify: `Program.cs` lines 33, 184-186
- Modify: `appsettings.json` connection string
- Delete: `Migrations/` (all files)
- Create: fresh `Migrations/InitialPostgres.cs` via `dotnet ef migrations add`
- Modify: 53 test files — `SqliteConnection` → Testcontainers PostgreSQL

**Step 1:** Swap packages in `.csproj`:

```xml
<!-- Replace -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.1" />
<!-- With -->
<PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="10.0.*" />
```

Add test dependency:
```xml
<PackageReference Include="Testcontainers.PostgreSql" Version="4.*" />
```

**Step 2:** In `Program.cs`, change provider:

```csharp
// Replace
options.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection"));
// With
options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection"));
```

Delete the three PRAGMA lines (184-186).

**Step 3:** Delete `Migrations/` directory entirely.

**Step 4:** Create fresh migration (need a running PostgreSQL for this — use docker):

```bash
docker run -d --name pg-tmp -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gamesvault -p 5432:5432 postgres:16
# Set connection string in appsettings.Development.json or env var
dotnet ef migrations add InitialPostgres
docker stop pg-tmp && docker rm pg-tmp
```

**Step 5:** Create `tests/games-vault.Tests/TestDbFixture.cs` — shared fixture that starts a PostgreSQL container:

```csharp
public sealed class TestDbFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
        .WithImage("postgres:16")
        .WithDatabase("gv_test")
        .WithUsername("test")
        .WithPassword("test")
        .Build();

    public string ConnectionString => _container.GetConnectionString();

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(ConnectionString)
            .Options;
        await using var db = new AppDbContext(options);
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await _container.DisposeAsync();
}
```

**Step 6:** Update `GamesVaultTestBase` and all test files to use `TestDbFixture.ConnectionString` instead of `SqliteConnection("Data Source=:memory:")`. Each test class gets the fixture via `IClassFixture<TestDbFixture>`.

**Verification:** `dotnet test` — all 216 tests pass against real PostgreSQL.

---

### Task 3: Persist Data Protection keys to disk

**Objective:** Data protection keys survive container restarts so admin cookies and encrypted data don't break.

**Files:**
- Modify: `Program.cs` — add `PersistKeysToFileSystem()`
- Modify: `appsettings.json` — add `DataProtection` path config

**Step 1:** In `Program.cs`, after `AddDataProtection()`, add:

```csharp
var dpPath = builder.Configuration.GetValue<string>("DataProtection:KeyRingPath")
    ?? Path.Combine(builder.Environment.ContentRootPath, "App_Data", "dp-keys");
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(dpPath));
```

**Step 2:** Add to `appsettings.json`:

```json
"DataProtection": {
  "KeyRingPath": "/var/lib/games-vault/dp-keys"
}
```

**Verification:** Start app, check `dp-keys/` directory has key XML files. Restart, confirm admin session survives.

---

### Task 4: Add health check endpoint

**Objective:** Docker and reverse proxies can monitor app health.

**Files:**
- Modify: `Program.cs` — add health check services and endpoint

**Step 1:** Register health checks:

```csharp
builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database")
    .AddCheck("nosebleed", () =>
    {
        var opts = builder.Configuration.GetSection("Nosebleed").Get<NosebleedOptions>();
        if (opts?.Enabled != true)
            return HealthCheckResult.Healthy("Nosebleed is disabled");
        if (!File.Exists(opts.BinaryPath))
            return HealthCheckResult.Unhealthy("Nosebleed binary not found");
        return HealthCheckResult.Healthy();
    });
```

**Step 2:** Map the endpoint:

```csharp
app.MapHealthChecks("/health");
```

**Verification:** `curl http://localhost:5217/health` returns `Healthy` with checks breakdown.

---

### Task 5: Session reconciliation on startup

**Objective:** On app restart, re-discover orphaned Nosebleed processes and reconcile room/seat state so nothing is left dangling.

**Files:**
- Modify: `Program.cs` — add startup reconciliation call
- Modify: `Nosebleed/NosebleedSessionManager.cs` — add `ReconcileOrphansAsync` method
- Create: (optional) `Nosebleed/NosebleedStartupReconciliation.cs` if you want it separate

**Step 1:** In `NosebleedSessionManager`, add a method that:
- Uses `NosebleedProcessInspector` to scan running processes
- For each orphan nosebleed process found: either re-adopt it (add to `_sessions` dictionary with session metadata) or kill it if there's no DB record of it
- Query `ArcadeCabinets` to re-link sessions to cabinets
- Query `GamePlayRooms` to re-link sessions to rooms

**Step 2:** Call this from `Program.cs` startup, after migrations:

```csharp
var reconciler = scope.ServiceProvider.GetRequiredService<NosebleedSessionManager>();
await reconciler.ReconcileOrphansAsync();
```

**Verification:** Start app, start a session, kill the app with SIGKILL, restart. Sessions should be re-adopted (or cleaned up), no zombie processes.

---

### Task 6: Graceful shutdown

**Objective:** On SIGTERM (docker stop), cleanly stop all Nosebleed processes, release seats, and close WebSocket connections before exiting.

**Files:**
- Modify: `Nosebleed/NosebleedSessionManager.cs` — implement `IDisposable` with shutdown logic
- Modify: `Program.cs` — register shutdown hook

**Step 1:** In `NosebleedSessionManager`, add:

```csharp
public async Task ShutdownAsync()
{
    foreach (var (key, managed) in _sessions.ToArray())
    {
        try
        {
            managed.Process.Kill(entireProcessTree: true);
            await managed.Process.WaitForExitAsync();
            _sessions.TryRemove(key, out _);
        }
        catch { /* process already dead */ }
    }
}
```

**Step 2:** Register in `Program.cs`:

```csharp
app.Lifetime.ApplicationStopping.Register(() =>
{
    var sm = app.Services.GetRequiredService<NosebleedSessionManager>();
    sm.ShutdownAsync().GetAwaiter().GetResult();
});
```

**Verification:** Start and then `docker stop`. Nosebleed processes should be killed, no zombies left.

---

### Task 7: Create Dockerfile

**Objective:** Multi-stage build that produces a self-contained Linux-x64 image.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1:** `.dockerignore`:

```
**/obj/
**/bin/
**/publish/
**/tests/
**/.git/
**/.github/
**/node_modules/
**/wwwroot/lib/
```

**Step 2:** `Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet restore
RUN dotnet publish -c Release -o /app --sc true -r linux-x64

FROM ubuntu:24.04 AS final
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-tools \
    libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 gv
WORKDIR /app
COPY --from=build /app .
RUN mkdir -p /data /var/lib/games-vault && chown -R gv:gv /app /data /var/lib/games-vault
USER gv
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:8080/health || exit 1
ENTRYPOINT ["./games-vault"]
```

**Verification:** `docker build -t games-vault . && docker run --rm -p 8080:8080 games-vault` — app starts and health check passes.

---

### Task 8: Create docker-compose.yml

**Objective:** One-command deployment with app + PostgreSQL + volume mounts + env configuration.

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Step 1:** `.env.example`:

```env
# Database
POSTGRES_PASSWORD=change-me
# App config
GV_LIBRARY_ROOT=/path/to/your/roms
GV_NOSEBLEED_ENABLED=true
GV_NOSEBLEED_PUBLIC_HOST=192.168.1.100
GV_PUBLIC_URL=http://localhost:8080
```

**Step 2:** `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: gamesvault
      POSTGRES_USER: gamesvault
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gamesvault"]
      interval: 5s
      retries: 5
    restart: unless-stopped

  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      ConnectionStrings__DefaultConnection: "Host=db;Database=gamesvault;Username=gamesvault;Password=${POSTGRES_PASSWORD}"
      Library__RootPath: ${GV_LIBRARY_ROOT:-/srv/storage/games}
      Library__UploadStagingRootPath: /data/uploads
      LibretroDatabase__RootPath: /data/libretro-db
      Nosebleed__Enabled: ${GV_NOSEBLEED_ENABLED:-false}
      Nosebleed__BinaryPath: /opt/nosebleed/nosebleed
      Nosebleed__PublicHost: ${GV_NOSEBLEED_PUBLIC_HOST:-localhost}
      Nosebleed__SessionRoot: /data/nosebleed-sessions
      Nosebleed__CoreRoot: /data/nosebleed-cores
      Nosebleed__AuthSecretPath: /data/nosebleed-auth-secret
      DataProtection__KeyRingPath: /data/dp-keys
    volumes:
      - appdata:/data
      - ${GV_LIBRARY_ROOT:-./roms}:/srv/storage/games:ro
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
  appdata:
```

**Verification:** `docker compose up -d && curl http://localhost:8080/health`

---

### Task 9: Environment-driven configuration

**Objective:** All config paths work as environment variables so the Docker image is configurable without editing appsettings.json.

**Files:**
- Modify: `Program.cs` — add env-aware configuration binding
- Verify: `appsettings.json` keys already follow `:` separator convention (works with `__` env var overrides in ASP.NET)

**Already done** — ASP.NET Core natively maps `Section__Key` env vars to config. The docker-compose.yml in Task 8 uses this. All appsettings keys are already reachable via env vars.

**Step 1:** Verify nothing reads config that can't be overridden by env vars. Check `NosebleedOptions` binding uses `IConfiguration.GetSection()` (it does — line 54 of Program.cs is already correct).

**Verification:** `GV__Nosebleed__Enabled=true dotnet run` — nosebleed is enabled without editing appsettings.json.

---

### Task 10: Remove `Access:AdminAlways` configuration key

**Objective:** Eliminate the footgun where a config toggle makes everyone admin.

**Files:**
- Modify: `Profiles/CurrentAccessService.cs` — remove `AdminAlways` check
- Modify: `appsettings.json` — remove `Access` section if present

**Step 1:** Delete lines 120-143 from `CurrentAccessService.cs` (the `IsAdminOverrideEnabled` method and its caller). The only admin path is now: profile with `IsAdmin = true` (set during profile creation for first profile) or admin cookie.

**Verification:** Set `Access:AdminAlways=true` in env, restart — still not admin unless your profile is actually admin.

---

### Task 11: Non-root user and signal handling

**Objective:** Container runs as non-root (uid 1000) and correctly forwards SIGTERM to .NET for graceful shutdown.

**Already partially done** — Dockerfile sets `USER gv`. .NET's generic host handles SIGTERM natively and triggers `IHostApplicationLifetime.ApplicationStopping`. The graceful shutdown in Task 6 hooks this.

**Step 1:** Verify the Dockerfile `USER gv` works with volume mounts:

```dockerfile
RUN mkdir -p /data /var/lib/games-vault && chown -R gv:gv /data /var/lib/games-vault
```

**Step 2:** Add `STOPSIGNAL SIGTERM` to Dockerfile (default, but explicit is better).

**Verification:** `docker run --rm games-vault`, then `docker stop <container>` — app shuts down cleanly, no zombies.

---

### Task 12: Ship documentation and defaults

**Objective:** Write a README that someone who's never used Games Vault can follow to get running in 5 minutes.

**Files:**
- Modify: `README.md`
- Create: `docs/docker-setup.md` (optional, for deeper config)

**Step 1:** `README.md` should include:

```markdown
# Games Vault

Self-hosted retro game streaming. Run your ROMs in a browser with WebRTC-quality streaming.

## Quick Start

1. Install Docker and docker-compose
2. Clone this repo
3. Copy `.env.example` to `.env` and edit `POSTGRES_PASSWORD` + `GV_LIBRARY_ROOT`
4. `docker compose up -d`
5. Open http://localhost:8080
6. Register with a passkey to become admin

## Requirements
- Docker 24+
- A passkey-capable device (iPhone, Android, Windows Hello, YubiKey, etc.)
- ROM files in a directory mounted as `/srv/storage/games`

## Configuration
All settings are in `.env`. See `.env.example` for all options.
```

**Verification:** Someone who's never seen this project can follow the steps and get it running.

---

## Order of Execution

1-2 (logging + PostgreSQL) can happen in parallel. Then 3-4-5-6 (robustness) in order. Then 7-8 (Docker). Then 9-10-11-12 (polish) in any order.

**Total estimate:** 3-4 days of focused work. PostgreSQL migration (Task 2) is the bottleneck — converting 53 test files.
