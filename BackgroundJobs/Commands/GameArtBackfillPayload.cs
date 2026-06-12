namespace games_vault.BackgroundJobs.Commands;

public sealed record GameArtBackfillPayload(bool Force = false, int Limit = 100, int? GameId = null);
