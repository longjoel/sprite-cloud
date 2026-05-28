using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.Controllers;

public sealed class SystemCoreMappingsController(
    AppDbContext db,
    SystemCoreMappingResolver resolver,
    SystemCoreAutomapper automapper,
    CurrentAccessService currentAccess,
    IOptions<NosebleedOptions> nosebleedOptions,
    LibretroCoreInstaller coreInstaller,
    InstalledCoreInventoryBuilder installedCoreInventoryBuilder) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            TempData["Message"] = "Admin profile required to manage system core mappings.";
            return RedirectToAction("Index", "Profiles");
        }

        var detected = await resolver.GetDetectedSystemsAsync(cancellationToken);
        var mappings = await db.SystemCoreMappings
            .AsNoTracking()
            .ToDictionaryAsync(x => x.SystemName, StringComparer.OrdinalIgnoreCase, cancellationToken);

        var rows = detected.Select(system =>
        {
            mappings.TryGetValue(system.SystemName, out var mapping);
            return new SystemCoreMappingRow
            {
                Id = mapping?.Id,
                SystemName = system.SystemName,
                GameCount = system.GameCount,
                NativeCoreFileName = system.NativeCoreFileName,
                WebPlayerCoreKey = mapping?.WebPlayerCoreKey,
                IsEnabled = mapping?.IsEnabled ?? system.IsEnabled,
                IsAutoMapped = mapping?.IsAutoMapped ?? false,
                HasNativeCoreMapping = system.HasNativeCoreMapping,
                Notes = mapping?.Notes
            };
        }).ToList();

        foreach (var extra in mappings.Values.Where(x => !rows.Any(r => string.Equals(r.SystemName, x.SystemName, StringComparison.OrdinalIgnoreCase))))
        {
            rows.Add(new SystemCoreMappingRow
            {
                Id = extra.Id,
                SystemName = extra.SystemName,
                NativeCoreFileName = extra.NativeCoreFileName,
                WebPlayerCoreKey = extra.WebPlayerCoreKey,
                IsEnabled = extra.IsEnabled,
                IsAutoMapped = extra.IsAutoMapped,
                HasNativeCoreMapping = extra.IsEnabled && !string.IsNullOrWhiteSpace(extra.NativeCoreFileName),
                Notes = extra.Notes
            });
        }

        rows = rows.OrderBy(r => r.SystemName).ToList();
        var installedNativeCores = GetInstalledNativeCores();
        var installedCoreInventory = installedCoreInventoryBuilder.Build(installedNativeCores, mappings.Values.ToList());

        return View(new SystemCoreMappingsIndexViewModel
        {
            Rows = rows,
            InstalledNativeCores = installedNativeCores,
            InstalledCoreInventory = installedCoreInventory
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Save(string systemName, string? nativeCoreFileName, string? webPlayerCoreKey, bool isEnabled = true, string? notes = null, CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            TempData["Message"] = "Admin profile required to manage system core mappings.";
            return RedirectToAction("Index", "Profiles");
        }

        systemName = (systemName ?? "").Trim();
        nativeCoreFileName = string.IsNullOrWhiteSpace(nativeCoreFileName) ? null : nativeCoreFileName.Trim();
        webPlayerCoreKey = string.IsNullOrWhiteSpace(webPlayerCoreKey) ? null : webPlayerCoreKey.Trim();
        notes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim();

        if (string.IsNullOrWhiteSpace(systemName))
        {
            TempData["Message"] = "System name is required.";
            return RedirectToAction(nameof(Index));
        }

        var mapping = await db.SystemCoreMappings.FirstOrDefaultAsync(x => x.SystemName == systemName, cancellationToken);
        if (mapping is null)
        {
            mapping = new SystemCoreMapping
            {
                SystemName = systemName,
                CreatedUtc = DateTime.UtcNow
            };
            db.SystemCoreMappings.Add(mapping);
        }

        mapping.NativeCoreFileName = nativeCoreFileName;
        mapping.WebPlayerCoreKey = webPlayerCoreKey;
        mapping.IsEnabled = isEnabled;
        mapping.IsAutoMapped = false;
        mapping.Notes = notes;
        mapping.UpdatedUtc = DateTime.UtcNow;

        await db.SaveChangesAsync(cancellationToken);
        TempData["Message"] = $"Saved core mapping for {systemName}.";
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AutoMap(CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            TempData["Message"] = "Admin profile required to manage system core mappings.";
            return RedirectToAction("Index", "Profiles");
        }

        var installResult = await coreInstaller.InstallKnownCoresForDetectedSystemsAsync(cancellationToken);
        var result = await automapper.AutoMapDetectedSystemsAsync(GetInstalledNativeCores(), cancellationToken);
        var installedText = installResult.Installed > 0
            ? $" Installed {installResult.Installed} missing core(s): {string.Join(", ", installResult.InstalledCores)}."
            : "";
        TempData["Message"] = $"Auto-map complete: created {result.Created}, updated {result.Updated}, missing installed core {result.MissingCore}, unknown system {result.UnknownSystem}." + installedText;
        return RedirectToAction(nameof(Index));
    }

    private IReadOnlyList<string> GetInstalledNativeCores()
    {
        var root = nosebleedOptions.Value?.CoreRoot;
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            return [];
        }

        return Directory.EnumerateFiles(root, "*_libretro.so", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFileName)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .OrderBy(x => x)
            .ToList();
    }
}
