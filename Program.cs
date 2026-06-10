using Microsoft.EntityFrameworkCore;
using games_vault.Arcade;
using games_vault.Gameplay;
using Microsoft.Data.Sqlite;
using games_vault.Libretro;
using games_vault.Nosebleed;
using games_vault.Web;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http.Features;

var builder = WebApplication.CreateBuilder(args);

// Allow large uploads (e.g. BIOS/system packs).
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 1024L * 1024L * 1024L; // 1 GiB
});
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 1024L * 1024L * 1024L; // 1 GiB
});

// Add services to the container.
builder.Services.AddControllersWithViews(options =>
{
    options.Filters.Add<CurrentProfileViewDataFilter>();
});
builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-CSRF-TOKEN";
});
builder.Services.AddDbContext<games_vault.Data.AppDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddSingleton<LibretroDatabaseSyncService>();
builder.Services.AddHttpClient();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddDataProtection();
builder.Services.AddScoped<CurrentProfileService>();
builder.Services.AddScoped<ProfileAuthSessionService>();
builder.Services.AddScoped<CurrentAccessService>();
builder.Services.AddScoped<PasskeyReadinessService>();
builder.Services.AddScoped<PasskeyService>();
builder.Services.AddScoped<ProfileInviteService>();
builder.Services.AddScoped<ProfileShareLinkService>();
builder.Services.AddScoped<LocalProfileService>();
builder.Services.AddScoped<ArcadeGameFileResolver>();
builder.Services.AddSingleton<SystemCoreMappingResolver>();
builder.Services.AddScoped<LibretroCoreInstaller>();
builder.Services.AddScoped<CurrentProfileViewDataFilter>();
builder.Services.AddScoped<AdminOnlyFilter>();
builder.Services.AddLibretroDatabase(builder.Configuration);
builder.Services.Configure<games_vault.Libretro.Import.LibraryStorageOptions>(builder.Configuration.GetSection("Library"));
builder.Services.Configure<NosebleedOptions>(builder.Configuration.GetSection("Nosebleed"));
builder.Services.AddSingleton<NosebleedTicketSigner>();
builder.Services.AddSingleton<NosebleedSessionManager>();
builder.Services.AddSingleton<NosebleedSeatManager>();
builder.Services.AddSingleton<NosebleedProcessInspector>();
builder.Services.AddSingleton<NosebleedStreamSettingsStore>();
builder.Services.AddSingleton<NosebleedRelayMetrics>();
builder.Services.AddScoped<GamePlayTelemetryService>();
builder.Services.AddSingleton<RoomCodeGenerator>();
builder.Services.AddScoped<GamePlayRoomService>();
builder.Services.AddSingleton<BatterySavePolicyResolver>();
builder.Services.AddScoped<ProfileBatterySaveService>();
builder.Services.AddScoped<BatterySaveRuntimeSyncService>();
builder.Services.AddHostedService<ArcadeCabinetSupervisor>();
builder.Services.AddSingleton<games_vault.NetworkShares.ISmbFileService, games_vault.NetworkShares.SmbLibraryFileService>();
builder.Services.AddSingleton<games_vault.Libretro.Import.GameFileStorage>();
builder.Services.AddSingleton<games_vault.Libretro.Import.SystemFileStorage>();
builder.Services.AddSingleton<games_vault.Libretro.Import.ProfileGameSaveStorage>();
builder.Services.AddSingleton<games_vault.Libretro.Dat.SystemDatIndexProvider>();
builder.Services.AddSingleton<games_vault.EverDrive.EverDriveGbFirmwareService>();

var app = builder.Build();

var configuredPathBase = app.Configuration["PathBase"]
    ?? app.Configuration["ASPNETCORE_PATHBASE"]
    ?? Environment.GetEnvironmentVariable("ASPNETCORE_PATHBASE");
if (!string.IsNullOrWhiteSpace(configuredPathBase))
{
    configuredPathBase = configuredPathBase.Trim();
    if (!configuredPathBase.StartsWith('/'))
    {
        configuredPathBase = "/" + configuredPathBase;
    }

    configuredPathBase = configuredPathBase.TrimEnd('/');
    if (!string.IsNullOrEmpty(configuredPathBase))
    {
        app.UsePathBase(configuredPathBase);
    }
}

app.Use(async (context, next) =>
{
    context.Response.Headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["X-Frame-Options"] = "DENY";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "frame-ancestors 'none'; " +
        "connect-src 'self' ws: wss:; " +
        "media-src 'self';";
    await next();
});

app.MapGet("/robots.txt", () => Results.Text("User-agent: *\nDisallow: /\n", "text/plain"));
// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();

app.UseStaticFiles();
app.UseWebSockets();
app.UseRouting();
app.UseMiddleware<ProfileSessionEnforcementMiddleware>();

app.UseAuthorization();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<games_vault.Data.AppDbContext>();

    // If you previously ran with EnsureCreated(), you may have a DB with tables but no migrations history.
    // MigrateAsync() can't adopt that schema automatically; you need to delete the DB or baseline it.
    try
    {
        var connection = db.Database.GetDbConnection();
        await connection.OpenAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText =
            """
            SELECT
              EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__EFMigrationsHistory') AS HasHistory,
              EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='Games') AS HasGames;
            """;

        await using var reader = await cmd.ExecuteReaderAsync();
        await reader.ReadAsync();
        var hasHistory = reader.GetInt64(0) == 1;
        var hasGames = reader.GetInt64(1) == 1;

        if (!hasHistory && hasGames)
        {
            throw new InvalidOperationException(
                "Existing SQLite DB was created without migrations (likely via EnsureCreated). " +
                "Delete the .db file (e.g. games-vault.dev.db) and restart, or baseline it before using migrations.");
        }
    }
    catch (SqliteException)
    {
        // If we can't probe schema, fall back to attempting the migration and surface any errors.
    }

    await db.Database.MigrateAsync();

    var nosebleedCoreRoot = builder.Configuration.GetValue<string>("Nosebleed:CoreRoot");
    if (!string.IsNullOrWhiteSpace(nosebleedCoreRoot))
    {
        if (builder.Configuration.GetValue("Nosebleed:AutoInstallKnownCores", true))
        {
            var installer = scope.ServiceProvider.GetRequiredService<LibretroCoreInstaller>();
            await installer.InstallKnownCoresForDetectedSystemsAsync();
        }
    }

    // Improve SQLite concurrency for live session activity.
    try
    {
        await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;");
        await db.Database.ExecuteSqlRawAsync("PRAGMA synchronous=NORMAL;");
        await db.Database.ExecuteSqlRawAsync("PRAGMA busy_timeout=5000;");
    }
    catch
    {
        // Non-fatal; continue with defaults if PRAGMAs fail.
    }
}

app.Run();
