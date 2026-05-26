using games_vault.Gameplay;

namespace games_vault.Tests;

public sealed class RoomCodeGeneratorTests
{
    [Fact]
    public void NextCode_ReturnsFourUppercaseLetters()
    {
        var generator = new RoomCodeGenerator();

        var code = generator.NextCode();

        Assert.Equal(4, code.Length);
        Assert.Matches("^[A-Z]{4}$", code);
    }

    [Theory]
    [InlineData("abCd", "ABCD")]
    [InlineData(" A-B C D ", "ABCD")]
    [InlineData("1234", null)]
    [InlineData("ABC", null)]
    public void NormalizeCode_EnforcesFourLetters(string raw, string? expected)
    {
        var normalized = GamePlayRoomService.NormalizeCode(raw);
        Assert.Equal(expected, normalized);
    }
}
