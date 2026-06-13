# #97 — Auto-import games when ROM folder changes

## T-1: Configuration model
**File:** `LibraryStorageOptions.cs`

Add watch folder settings:
```csharp
public sealed class WatchFolderOptions
{
    public bool Enabled { get; set; }
    public string Path { get; set; } = "App_Data/watch";
    public int DebounceMs { get; set; } = 2000;
    public ImportMode Mode { get; set; } = ImportMode.Link;
}

public enum ImportMode { Link = 0, Copy = 1 }
```

Nest under `LibraryStorageOptions` or use a separate config section `"WatchFolder"`.

---

## T-2: RomWatchImportPayload + RomWatchImportCommand
**Files:** `BackgroundJobs/Commands/RomWatchImportPayload.cs`, `BackgroundJobs/Commands/RomWatchImportCommand.cs`

Payload: `{ Paths: string[], Mode: ImportMode }`

Command:
- `Link` mode → call `GameUploadImporter.ImportLinkedLocalFilesAsync(paths)`
- `Copy` mode → copy files to a temp staging dir, call `GameUploadImporter.ImportFromStagedDirectoryAsync(dir)`
- Log per-file results via execution context
- Single-file failures don't fail the batch
- Register as `"rom.watch"` in `Program.cs`

---

## T-3: RomFolderWatcher hosted service — initial skeleton + startup reconcile
**File:** `BackgroundJobs/RomFolderWatcher.cs`

- `BackgroundService` that reads options from `IOptionsSnapshot<WatchFolderOptions>`
- **Startup reconcile:** enumerate all files in watch folder, cross-reference against DB, enqueue `rom.watch` job for unrecognized files
- Runs only when `WatchFolderOptions.Enabled == true`
- Log reconcile counts (scanned, new, previously-imported, missing-from-disk)

---

## T-4: RomFolderWatcher — FileSystemWatcher + debounce
**File:** `BackgroundJobs/RomFolderWatcher.cs` (add to same class)

- Create `FileSystemWatcher` on the watch folder (include subdirectories)
- Listen for `Created`, `Changed`, `Renamed`
- Debounce via `CancellationTokenSource` + `Task.Delay` — new events cancel the pending timer and restart it
- On timer expiry: deduplicate accumulated paths, enqueue `rom.watch` job
- Guard against double-watch on rename (same file both created and deleted)

---

## T-5: RomFolderWatcher — deletion handling
**File:** `BackgroundJobs/RomFolderWatcher.cs` (add)

- `Deleted` event: update matching `GameFile` records:
  - Set `ExternalPath = null` (don't delete the game/saves/art)
  - Log the unlink
- Batch update via `ExecuteUpdateAsync`

---

## T-6: Wire up + config
**Files:** `Program.cs`, `appsettings.json`

- Register `RomFolderWatcher` with `AddHostedService`
- Bind `WatchFolderOptions` from configuration
- Add `"WatchFolder"` section to example appsettings

---

## T-7: Tests

- Debounce timer fires once after multiple rapid events
- New file → import enqueued
- Already-imported file → skipped
- Deletion → `ExternalPath` cleared, game record preserved
- Startup reconcile catches files added while offline
- `RomWatchImportCommand` handles invalid paths gracefully
