using System.Text.Json;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Nosebleed;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace games_vault.BackgroundJobs.Commands;

public sealed class ValidationRunCommand(
    AppDbContext db,
    IOptions<NosebleedOptions> nosebleedOptions,
    SystemFileStorage systemFileStorage) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = JsonSerializer.Deserialize<ValidationRunPayload>(payload.GetRawText(), JobJson.Options);
        if (typed is null)
        {
            await context.LogWarnAsync("validation.run: received null payload, skipping.", cancellationToken);
            return;
        }

        await context.SetProgressPermilleAsync(0, cancellationToken);

        if (typed.ValidateCores)
            await ValidateCoresAsync(context, cancellationToken);

        if (typed.ValidateSystemFiles)
            await ValidateSystemFilesAsync(context, cancellationToken);

        await context.SetProgressPermilleAsync(1000, cancellationToken);
        await context.LogInfoAsync("validation.run: complete.", cancellationToken);
    }

    // ── Core validation ────────────────────────────────────────────────

    private async Task ValidateCoresAsync(BackgroundJobExecutionContext context, CancellationToken cancellationToken)
    {
        await context.LogInfoAsync("validation.run: validating cores...", cancellationToken);

        var coreRoot = nosebleedOptions.Value.CoreRoot;
        if (string.IsNullOrWhiteSpace(coreRoot))
        {
            await context.LogErrorAsync("validation.run: Nosebleed:CoreRoot is not configured — cannot validate cores.", cancellationToken);
            return;
        }

        if (!Directory.Exists(coreRoot))
        {
            await context.LogWarnAsync($"validation.run: core directory does not exist: {coreRoot}", cancellationToken);
        }

        var systems = await db.Games
            .AsNoTracking()
            .Where(g => g.SystemName != null && g.SystemName != "")
            .Select(g => g.SystemName)
            .Distinct()
            .ToListAsync(cancellationToken);

        if (systems.Count == 0)
        {
            await context.LogInfoAsync("validation.run: no games in library, nothing to validate.", cancellationToken);
            return;
        }

        var present = 0;
        var missing = 0;
        var unknown = 0;

        foreach (var systemName in systems.OrderBy(x => x))
        {
            cancellationToken.ThrowIfCancellationRequested();

            var entry = CoreCompatibilityCatalog.Find(systemName);
            if (entry is null)
            {
                unknown++;
                continue;
            }

            var corePath = Path.GetFullPath(Path.Combine(coreRoot, entry.NativeCoreFileName));
            if (File.Exists(corePath))
            {
                present++;
            }
            else
            {
                missing++;
                await context.LogWarnAsync($"  Missing core: {entry.NativeCoreFileName} for \"{systemName}\"", cancellationToken);
            }
        }

        await context.LogInfoAsync(
            $"validation.run (cores): {present} present, {missing} missing, {unknown} unknown systems in library.", cancellationToken);
    }

    // ── System-file validation ─────────────────────────────────────────

    private async Task ValidateSystemFilesAsync(BackgroundJobExecutionContext context, CancellationToken cancellationToken)
    {
        await context.LogInfoAsync("validation.run: validating system files...", cancellationToken);

        var files = await db.SystemFiles
            .AsNoTracking()
            .OrderBy(f => f.SystemName)
            .ThenBy(f => f.FileName)
            .ToListAsync(cancellationToken);

        if (files.Count == 0)
        {
            await context.LogInfoAsync("validation.run: no system files in database.", cancellationToken);
            return;
        }

        var present = 0;
        var missing = 0;

        foreach (var file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                var absPath = systemFileStorage.GetAbsolutePath(file.StoragePath);
                if (File.Exists(absPath))
                {
                    present++;
                }
                else
                {
                    missing++;
                    await context.LogWarnAsync($"  Missing system file: \"{file.FileName}\" ({file.SystemName}) — expected at {file.StoragePath}", cancellationToken);
                }
            }
            catch (Exception ex)
            {
                missing++;
                await context.LogWarnAsync($"  Invalid system file path for \"{file.FileName}\" ({file.SystemName}): {ex.Message}", cancellationToken);
            }
        }

        await context.LogInfoAsync(
            $"validation.run (system files): {present} present, {missing} missing ({files.Count} total in DB).", cancellationToken);
    }
}
