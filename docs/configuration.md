# Configuration

Games Vault uses ASP.NET Core's configuration hierarchy. Every setting in
`appsettings.json` can be overridden via environment variables using the `__`
(double underscore) separator for nested keys.

---

## Env var reference

### Connection strings

| Env var | appsettings.json | Default |
|---------|------------------|---------|
| `ConnectionStrings__DefaultConnection` | `ConnectionStrings:DefaultConnection` | `Host=localhost;...` |

### Library / game storage

| Env var | appsettings.json | Default |
|---------|------------------|---------|
| `Library__RootPath` | `Library:RootPath` | `/srv/storage/games` |
| `Library__UploadStagingRootPath` | `Library:UploadStagingRootPath` | `/srv/storage/games-vault/uploads` |
| `LibretroDatabase__RootPath` | `LibretroDatabase:RootPath` | `/srv/storage/games-vault/App_Data/libretro-database` |
| `LibretroDatabase__ZipUrl` | `LibretroDatabase:ZipUrl` | `https://github.com/libretro/libretro-database/archive/refs/heads/master.zip` |

### Nosebleed (streaming runtime)

| Env var | appsettings.json | Default |
|---------|------------------|---------|
| `Nosebleed__Enabled` | `Nosebleed:Enabled` | `false` |
| `Nosebleed__BinaryPath` | `Nosebleed:BinaryPath` | `/opt/nosebleed/nosebleed` |
| `Nosebleed__PublicScheme` | `Nosebleed:PublicScheme` | `http` |
| `Nosebleed__PublicHost` | `Nosebleed:PublicHost` | `192.168.86.126` |
| `Nosebleed__BaseListenPort` | `Nosebleed:BaseListenPort` | `8100` |
| `Nosebleed__MaxSessions` | `Nosebleed:MaxSessions` | `4` |
| `Nosebleed__MaxPlayersPerSession` | `Nosebleed:MaxPlayersPerSession` | `4` |
| `Nosebleed__SeatTtlMinutes` | `Nosebleed:SeatTtlMinutes` | `30` |
| `Nosebleed__TicketTtlMinutes` | `Nosebleed:TicketTtlMinutes` | `120` |
| `Nosebleed__Fps` | `Nosebleed:Fps` | `60` |
| `Nosebleed__SessionRoot` | `Nosebleed:SessionRoot` | `/srv/storage/games-vault/nosebleed/sessions` |
| `Nosebleed__CoreRoot` | `Nosebleed:CoreRoot` | `/srv/storage/games-vault/nosebleed/cores` |
| `Nosebleed__CoreBuildbotBaseUrl` | `Nosebleed:CoreBuildbotBaseUrl` | `https://buildbot.libretro.com/nightly/linux/x86_64/latest` |
| `Nosebleed__AutoInstallKnownCores` | `Nosebleed:AutoInstallKnownCores` | `true` |
| `Nosebleed__RequireAuth` | `Nosebleed:RequireAuth` | `true` |
| `Nosebleed__AuthSecretPath` | `Nosebleed:AuthSecretPath` | `/var/lib/games-vault/nosebleed-auth-secret` |
| `Nosebleed__CopyContentToSession` | `Nosebleed:CopyContentToSession` | `true` |
| `Nosebleed__TurnSecret` | `Nosebleed:TurnSecret` | *(none)* |
| `Nosebleed__TurnHost` | `Nosebleed:TurnHost` | *(none)* |
| `Nosebleed__TurnUrlInternal` | `Nosebleed:TurnUrlInternal` | *(none)* |
| `Nosebleed__SystemCores__{System}` | `Nosebleed:SystemCores:{System}` | *(varies)* |

### Data protection

| Env var | appsettings.json | Default |
|---------|------------------|---------|
| `DataProtection__KeyRingPath` | `DataProtection:KeyRingPath` | `/var/lib/games-vault/dp-keys` |

### Path base (reverse proxy path routing)

| Env var | Config key | Default |
|---------|------------|---------|
| `PathBase` | `PathBase` | *(none)* |
| `ASPNETCORE_PATHBASE` | *(legacy, read directly)* | *(none)* |

### Logging (Serilog)

| Env var | Config key | Default |
|---------|------------|---------|
| `Serilog__MinimumLevel__Default` | `Serilog:MinimumLevel:Default` | `Information` |
| `Serilog__MinimumLevel__Override__Microsoft.AspNetCore` | `Serilog:MinimumLevel:Override:Microsoft.AspNetCore` | `Warning` |
| `Serilog__MinimumLevel__Override__Microsoft.EntityFrameworkCore` | `Serilog:MinimumLevel:Override:Microsoft.EntityFrameworkCore` | `Warning` |

### Other

| Env var | appsettings.json | Default |
|---------|------------------|---------|
| `AllowedHosts` | `AllowedHosts` | `*` |

---

## Verification

All settings above follow the standard ASP.NET Core convention: environment
variable `Section__Key` maps to `Section:Key` in the JSON config tree. No
custom config providers or hardcoded fallbacks bypass this mechanism.

The Nosebleed section is bound via `IOptions<NosebleedOptions>` (see
`Program.cs` line 83), which automatically picks up env var overrides.

To test that env vars work:

```bash
# Override DB connection string at runtime
ConnectionStrings__DefaultConnection="Host=test;..." dotnet run

# Enable Nosebleed streaming
Nosebleed__Enabled=true dotnet run
```
