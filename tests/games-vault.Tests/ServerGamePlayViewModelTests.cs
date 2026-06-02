using games_vault.Models;
using games_vault.Models.ViewModels;

namespace games_vault.Tests;

public sealed class ServerGamePlayViewModelTests
{
    [Fact]
    public void ChatIdentityLabel_FallsBackWhenGuestOwnerIsUnknown()
    {
        var model = new ServerGamePlayViewModel
        {
            Game = new Game { Name = "Test Game", SystemName = "Sega - Mega Drive - Genesis", SizeBytes = 1 },
            CurrentProfileIsEphemeralGuest = true
        };

        Assert.Equal("Chatting as guest", model.ChatIdentityLabel);
    }
}
