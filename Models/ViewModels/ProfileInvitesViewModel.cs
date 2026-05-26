using games_vault.Models;

namespace games_vault.Models.ViewModels;

public sealed class ProfileInvitesViewModel
{
    public IReadOnlyList<ProfileInviteRowViewModel> Invites { get; init; } = [];
    public string? NewInviteLink { get; init; }
}

public sealed class ProfileInviteRowViewModel
{
    public string Code { get; init; } = "";
    public string InviteLink { get; init; } = "";
    public DateTime CreatedUtc { get; init; }
    public DateTime? UsedUtc { get; init; }
    public string? UsedByProfileName { get; init; }
    public bool IsUsed => UsedUtc is not null;
}
