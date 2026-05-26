using Microsoft.EntityFrameworkCore;
using games_vault.Arcade;
using games_vault.BackgroundJobs;
using games_vault.Gameplay;
using Microsoft.Data.Sqlite;
using games_vault.Libretro;
using games_vault.Nosebleed;
using games_vault.Web;
using games_vault.Profiles;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.FileProviders.Physical;

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
builder.Services.AddDbContext<games_vault.Data.AppDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddBackgroundJobs();
builder.Services.AddHttpClient();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<CurrentProfileService>();
builder.Services.AddScoped<CurrentAccessService>();
builder.Services.AddScoped<PasskeyReadinessService>();
builder.Services.AddScoped<PasskeyService>();
builder.Services.AddScoped<ProfileInviteService>();
builder.Services.AddScoped<LocalProfileService>();
builder.Services.AddScoped<ArcadeGameFileResolver>();
builder.Services.AddScoped<SystemCoreMappingResolver>();
builder.Services.AddScoped<SystemCoreAutomapper>();
builder.Services.AddScoped<LibretroCoreInstaller>();
builder.Services.AddScoped<CurrentProfileViewDataFilter>();
builder.Services.AddLibretroDatabase(builder.Configuration);
builder.Services.Configure<games_vault.Libretro.Import.LibraryStorageOptions>(builder.Configuration.GetSection("Library"));
builder.Services.Configure<WebPlayerOptions>(builder.Configuration.GetSection("WebPlayer"));
builder.Services.Configure<NosebleedOptions>(builder.Configuration.GetSection("Nosebleed"));
builder.Services.AddSingleton<NosebleedTicketSigner>();
builder.Services.AddSingleton<NosebleedSessionManager>();
builder.Services.AddSingleton<NosebleedSeatManager>();
builder.Services.AddSingleton<NosebleedProcessInspector>();
builder.Services.AddScoped<GamePlayTelemetryService>();
builder.Services.AddSingleton<WebPlayerAssetLocator>();
builder.Services.AddHostedService<WebPlayerBootstrapper>();
builder.Services.AddHostedService<ArcadeCabinetSupervisor>();
builder.Services.AddSingleton<WebPlayerDataStorage>();
builder.Services.AddSingleton<games_vault.NetworkShares.ISmbFileService, games_vault.NetworkShares.SmbLibraryFileService>();
builder.Services.AddSingleton<games_vault.Libretro.Import.GameFileStorage>();
builder.Services.AddSingleton<games_vault.Libretro.Import.SystemFileStorage>();
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

// RetroArch's web player relies on dotfiles (e.g. "/webplayer/assets/cores/.index-xhr") and unusual extensions
// (e.g. "bundle.zip.aa"). ASP.NET Core's default WebRootFileProvider excludes dotfiles.
app.UseStaticFiles(new StaticFileOptions
{
    // RetroArch's web player uses extension-less / uncommon extension assets (e.g. ".index-xhr", "bundle.zip.aa").
    // Serve them as octet-stream so BrowserFS/XHR can fetch them.
    ServeUnknownFileTypes = true,
    FileProvider = string.IsNullOrWhiteSpace(app.Environment.WebRootPath)
        ? app.Environment.WebRootFileProvider
        : new PhysicalFileProvider(app.Environment.WebRootPath, ExclusionFilters.None)
});
app.UseWebSockets();
app.UseRouting();

app.UseAuthorization();

app.MapStaticAssets();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}")
    .WithStaticAssets();

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

    var configuredNativeCores = builder.Configuration.GetSection("Nosebleed:SystemCores")
        .Get<Dictionary<string, string>>() ?? [];
    var configuredWebCores = builder.Configuration.GetSection("WebPlayer:SystemCores")
        .Get<Dictionary<string, string>>() ?? [];
    foreach (var pair in configuredNativeCores)
    {
        var systemName = pair.Key.Trim();
        if (string.IsNullOrWhiteSpace(systemName))
        {
            continue;
        }

        var mapping = await db.SystemCoreMappings.FirstOrDefaultAsync(x => x.SystemName == systemName);
        if (mapping is null)
        {
            mapping = new games_vault.Models.SystemCoreMapping
            {
                SystemName = systemName,
                CreatedUtc = DateTime.UtcNow
            };
            db.SystemCoreMappings.Add(mapping);
        }

        if (string.IsNullOrWhiteSpace(mapping.NativeCoreFileName) && !string.IsNullOrWhiteSpace(pair.Value))
        {
            mapping.NativeCoreFileName = pair.Value.Trim();
        }

        if (string.IsNullOrWhiteSpace(mapping.WebPlayerCoreKey) &&
            configuredWebCores.TryGetValue(systemName, out var webCore) &&
            !string.IsNullOrWhiteSpace(webCore))
        {
            mapping.WebPlayerCoreKey = webCore.Trim();
        }

        mapping.UpdatedUtc = DateTime.UtcNow;
    }
    if (configuredNativeCores.Count > 0)
    {
        await db.SaveChangesAsync();
    }

    var nosebleedCoreRoot = builder.Configuration.GetValue<string>("Nosebleed:CoreRoot");
    if (!string.IsNullOrWhiteSpace(nosebleedCoreRoot))
    {
        if (builder.Configuration.GetValue("Nosebleed:AutoInstallKnownCores", true))
        {
            var installer = scope.ServiceProvider.GetRequiredService<LibretroCoreInstaller>();
            await installer.InstallKnownCoresForDetectedSystemsAsync();
        }

        if (Directory.Exists(nosebleedCoreRoot))
        {
            var installedNativeCores = Directory.EnumerateFiles(nosebleedCoreRoot, "*_libretro.so", SearchOption.TopDirectoryOnly)
                .Select(Path.GetFileName)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x!)
                .ToList();
            var automapper = scope.ServiceProvider.GetRequiredService<SystemCoreAutomapper>();
            await automapper.AutoMapDetectedSystemsAsync(installedNativeCores);
        }
    }

    // Improve SQLite concurrency for the (chatty) web player sync workload.
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
