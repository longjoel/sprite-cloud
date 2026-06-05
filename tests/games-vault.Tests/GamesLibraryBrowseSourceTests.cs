namespace games_vault.Tests;

public sealed class GamesLibraryBrowseSourceTests
{
    private static string ReadController()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        return File.ReadAllText(Path.Combine(repoRoot, "Controllers", "GamesController.cs")).Replace("\r\n", "\n");
    }

    [Fact]
    public void Games_Bank_And_Index_Use_The_Same_Typed_Browse_Query()
    {
        var content = ReadController();

        Assert.Contains("[FromQuery] GamesLibraryBrowseQuery browse", content);
        Assert.Contains("BuildGamesBankAsync(browse, batchId, cancellationToken)", content);
        Assert.Contains("private async Task<GamesBankViewModel> BuildGamesBankAsync(GamesLibraryBrowseQuery? browse", content);
    }

    [Fact]
    public void Games_Library_Search_Covers_Name_System_File_And_Crc()
    {
        var content = ReadController();

        Assert.Contains("ApplyGamesLibrarySearch", content);
        Assert.Contains("g.Name.ToLower().Contains(qLower)", content);
        Assert.Contains("g.SystemName.ToLower().Contains(qLower)", content);
        Assert.Contains("f.Name.ToLower().Contains(qLower)", content);
        Assert.Contains("f.Crc32 != null && f.Crc32.ToLower().Contains(qLower)", content);
    }

    [Fact]
    public void Games_Library_Filters_And_Sorts_Cover_Requested_Browse_Modes()
    {
        var content = ReadController();

        Assert.Contains("browse.System", content);
        Assert.Contains("browse.Players", content);
        Assert.Contains("browse.PlayingNow", content);
        Assert.Contains("GamePlayRoomStatus.Active", content);
        Assert.Contains("GamesLibrarySort.AlphabeticalAsc", content);
        Assert.Contains("GamesLibrarySort.AlphabeticalDesc", content);
        Assert.Contains("GamesLibrarySort.RecentlyPlayed", content);
        Assert.Contains("GamesLibrarySort.MostPlayedAllTime", content);
        Assert.Contains("GamesLibrarySort.MostPlayedThisWeek", content);
        Assert.Contains("GamesLibrarySort.NumberOfPlayers", content);
        Assert.Contains("GamesLibrarySort.System", content);
    }

    [Fact]
    public void Games_Library_Grouping_Covers_Requested_Group_Modes()
    {
        var content = ReadController();

        Assert.Contains("GamesLibraryGroup.System", content);
        Assert.Contains("GamesLibraryGroup.Alphabetical", content);
        Assert.Contains("GamesLibraryGroup.NumberOfPlayers", content);
        Assert.Contains("GamesLibraryGroup.CurrentlyPlaying", content);
        Assert.Contains("Playing now", content);
        Assert.Contains("Not currently playing", content);
    }
}
