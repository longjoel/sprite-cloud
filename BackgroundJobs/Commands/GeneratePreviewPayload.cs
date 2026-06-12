namespace games_vault.BackgroundJobs.Commands;

public sealed record GeneratePreviewJobPayload(int GameId, bool Force = false);
