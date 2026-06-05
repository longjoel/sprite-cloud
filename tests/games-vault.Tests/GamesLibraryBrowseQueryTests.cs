namespace games_vault.Tests;

using games_vault.Models.ViewModels;

public sealed class GamesLibraryBrowseQueryTests
{
    [Fact]
    public void Normalize_Trims_Search_And_Filter_Text_And_Clamps_Pagination()
    {
        var query = new GamesLibraryBrowseQuery
        {
            Q = "  sonic  ",
            System = "  Sega - Genesis  ",
            Players = 2,
            Page = -4,
            PageSize = 500,
            Sort = GamesLibrarySort.AlphabeticalAsc,
            Group = GamesLibraryGroup.System
        };

        var normalized = query.Normalize();

        Assert.Equal("sonic", normalized.Q);
        Assert.Equal("Sega - Genesis", normalized.System);
        Assert.Equal(2, normalized.Players);
        Assert.Equal(1, normalized.Page);
        Assert.Equal(100, normalized.PageSize);
        Assert.Equal(GamesLibrarySort.AlphabeticalAsc, normalized.Sort);
        Assert.Equal(GamesLibraryGroup.System, normalized.Group);
        Assert.True(normalized.HasActiveFilters);
    }

    [Fact]
    public void Normalize_Treats_Blank_And_NonPositive_Filters_As_Inactive()
    {
        var normalized = new GamesLibraryBrowseQuery
        {
            Q = " ",
            System = "\t",
            Players = 0,
            Page = 3,
            PageSize = 1
        }.Normalize();

        Assert.Null(normalized.Q);
        Assert.Null(normalized.System);
        Assert.Null(normalized.Players);
        Assert.Equal(3, normalized.Page);
        Assert.Equal(5, normalized.PageSize);
        Assert.False(normalized.HasActiveFilters);
    }
}
