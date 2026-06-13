using System.Text.Json;
using games_vault.Nosebleed;

namespace games_vault.BackgroundJobs.Commands;

public sealed record NosebleedAuditPayload(bool Cleanup = false);

public sealed class NosebleedAuditCommand(
    NosebleedProcessInspector processInspector,
    NosebleedSessionManager sessionManager) : IBackgroundJobCommand
{
    public async Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        var typed = JsonSerializer.Deserialize<NosebleedAuditPayload>(payload.GetRawText(), JobJson.Options);
        if (typed is null)
        {
            await context.LogWarnAsync("nosebleed.audit: received null payload, skipping.", cancellationToken);
            return;
        }

        await context.SetProgressPermilleAsync(0, cancellationToken);

        var managedPids = sessionManager.GetManagedProcessIds();
        var allProcesses = processInspector.GetProcesses();
        var orphanProcesses = processInspector.GetOrphanProcesses(managedPids);

        await context.LogInfoAsync(
            $"nosebleed.audit: {allProcesses.Count} total processes, " +
            $"{managedPids.Count} managed, " +
            $"{orphanProcesses.Count} unmanaged.",
            cancellationToken);

        foreach (var process in allProcesses)
        {
            var isManaged = managedPids.Contains(process.ProcessId);
            await context.LogInfoAsync(
                $"  PID {process.ProcessId}: {(isManaged ? "managed" : "unmanaged")} — " +
                $"session={process.SessionId ?? "(none)"}, " +
                $"core={process.CorePath ?? "(unknown)"}, " +
                $"content={process.ContentPath ?? "(unknown)"}, " +
                $"port={process.Port?.ToString() ?? "(none)"}",
                cancellationToken);
        }

        var killed = 0;
        var killErrors = 0;

        if (typed.Cleanup && orphanProcesses.Count > 0)
        {
            await context.LogInfoAsync("nosebleed.audit: cleanup mode — terminating unmanaged Nosebleed processes...", cancellationToken);

            foreach (var process in orphanProcesses)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (processInspector.TryKillIfNosebleed(process.ProcessId))
                {
                    killed++;
                    await context.LogInfoAsync($"  Killed PID {process.ProcessId} ({process.SessionId ?? "no session"}).", cancellationToken);
                }
                else
                {
                    killErrors++;
                    await context.LogWarnAsync($"  Failed to kill PID {process.ProcessId} — process may have already exited or been revalidated.", cancellationToken);
                }
            }
        }

        await context.SetProgressPermilleAsync(1000, cancellationToken);

        var summary = typed.Cleanup
            ? $"nosebleed.audit: complete — {orphanProcesses.Count} unmanaged found, {killed} killed, {killErrors} errors."
            : $"nosebleed.audit: complete — {orphanProcesses.Count} unmanaged processes would be killed in cleanup mode.";

        await context.LogInfoAsync(summary, cancellationToken);
    }
}
