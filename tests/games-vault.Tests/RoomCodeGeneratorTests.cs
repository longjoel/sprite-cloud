using games_vault.Gameplay;

namespace games_vault.Tests;

public sealed class RoomCodeGeneratorTests
{
    [Fact]
    public void NextCode_ReturnsSixUppercaseLetters()
    {
        var generator = new RoomCodeGenerator();

        var code = generator.NextCode();

        Assert.Equal(6, code.Length);
        Assert.Matches("^[A-Z]{6}$", code);
    }

    [Theory]
    [InlineData("aBcDeF", "ABCDEF")]
    [InlineData(" A-B C D-E F", "ABCDEF")]
    [InlineData("123456", null)]
    [InlineData("ABCDE", null)]
    public void NormalizeCode_EnforcesSixLetters(string raw, string? expected)
    {
        var normalized = GamePlayRoomService.NormalizeCode(raw);
        Assert.Equal(expected, normalized);
    }
}
