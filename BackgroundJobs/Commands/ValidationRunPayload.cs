namespace games_vault.BackgroundJobs.Commands;

/// <summary>
/// Payload for the validation.run command.
/// Specifies which validations to execute.
/// </summary>
public sealed record ValidationRunPayload(
    bool ValidateCores,
    bool ValidateSystemFiles);
