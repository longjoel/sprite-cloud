namespace games_vault.BackgroundJobs.Commands;

public sealed record SyncLibretroDatabasePayload(bool Force = false);
