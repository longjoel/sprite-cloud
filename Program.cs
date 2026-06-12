using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using games_vault.Arcade;
using games_vault.Gameplay;
using games_vault.Libretro;
using games_vault.Nosebleed;
using games_vault.Web;
using games_vault.Profiles;
using games_vault.BackgroundJobs;
using games_vault.BackgroundJobs.Commands;
using games_vault.Services;
using Serilog;
using Serilog.Formatting.Json;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

var dataProtectionKeyRingPath = builder.Configuration["DataProtection:KeyRingPath"];
if (string.IsNullOrWhiteSpace(dataProtectionKeyRingPath))
{
    dataProtectionKeyRingPath = Path.Combine(builder.Environment.ContentRootPath, "App_Data", "dp-keys");
}
else if (!Path.IsPathRooted(dataProtectionKeyRingPath))
{
    dataProtectionKeyRingPath = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, dataProtectionKeyRingPath));
}

Directory.CreateDirectory(dataProtectionKeyRingPath);

Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console(formatter: new JsonFormatter())
    .CreateLogger();

builder.Host.UseSerilog();

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
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddHealthChecks()
    .AddDbContextCheck<games_vault.Data.AppDbContext>("database")
    .AddCheck<NosebleedHealthCheck>("nosebleed");
builder.Services.AddSingleton<LibretroDatabaseSyncService>();
builder.Services.AddHttpClient();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(dataProtectionKeyRingPath));
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
builder.Services.AddSingleton<ITurnCredentialService, TurnCredentialService>();
builder.Services.AddScoped<GamePlayTelemetryService>();
builder.Services.AddSingleton<RoomCodeGenerator>();
builder.Services.AddScoped<GamePlayRoomService>();
builder.Services.AddScoped<GameArtBackfillService>();
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

// Background jobs infrastructure
builder.Services.AddScoped<IBackgroundJobClient, BackgroundJobClient>();
builder.Services.AddSingleton<BackgroundJobCommandRegistry>(_ => new BackgroundJobCommandRegistry(new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase)
{
    ["preview.generate"] = typeof(GeneratePreviewCommand),
    ["art.backfill"] = typeof(GameArtBackfillCommand)
}));
builder.Services.AddTransient<GeneratePreviewCommand>();
builder.Services.AddTransient<GameArtBackfillCommand>();
builder.Services.AddHostedService<BackgroundJobWorker>();

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();

var startupNosebleedSessionManager = app.Services.GetRequiredService<NosebleedSessionManager>();
app.Lifetime.ApplicationStopping.Register(() =>
{
    startupNosebleedSessionManager.ShutdownAsync().GetAwaiter().GetResult();
});

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
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; " +
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
app.UseForwardedHeaders();
app.UseMiddleware<ProfileSessionEnforcementMiddleware>();

app.UseAuthorization();

app.MapHealthChecks("/health", new HealthCheckOptions
{
    ResponseWriter = async (context, report) =>
    {
        context.Response.ContentType = "application/json";

        var payload = new
        {
            status = report.Status.ToString(),
            checks = report.Entries.ToDictionary(
                entry => entry.Key,
                entry => new
                {
                    status = entry.Value.Status.ToString(),
                    description = entry.Value.Description,
                    error = entry.Value.Exception?.Message,
                    duration = entry.Value.Duration.TotalMilliseconds
                })
        };

        await context.Response.WriteAsync(JsonSerializer.Serialize(payload));
    }
});

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<games_vault.Data.AppDbContext>();
    await db.Database.MigrateAsync();

    var nosebleedSessionManager = scope.ServiceProvider.GetRequiredService<NosebleedSessionManager>();
    var reconcileResult = await nosebleedSessionManager.ReconcileOrphansAsync();
    if (reconcileResult.AdoptedSessions > 0 || reconcileResult.KilledOrphanProcesses > 0 || reconcileResult.RelinkedRooms > 0 || reconcileResult.RelinkedCabinets > 0)
    {
        Log.Information(
            "Nosebleed orphan reconciliation complete. Adopted={AdoptedSessions} Killed={KilledOrphanProcesses} RelinkedRooms={RelinkedRooms} RelinkedCabinets={RelinkedCabinets}",
            reconcileResult.AdoptedSessions,
            reconcileResult.KilledOrphanProcesses,
            reconcileResult.RelinkedRooms,
            reconcileResult.RelinkedCabinets);
    }

    var nosebleedCoreRoot = builder.Configuration.GetValue<string>("Nosebleed:CoreRoot");
    if (!string.IsNullOrWhiteSpace(nosebleedCoreRoot))
    {
        if (builder.Configuration.GetValue("Nosebleed:AutoInstallKnownCores", true))
        {
            var installer = scope.ServiceProvider.GetRequiredService<LibretroCoreInstaller>();
            await installer.InstallKnownCoresForDetectedSystemsAsync();
        }
    }

}

app.Run();
