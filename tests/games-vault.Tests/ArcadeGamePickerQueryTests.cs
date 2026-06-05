namespace games_vault.Tests;

using games_vault.Models.ViewModels;

public sealed class ArcadeGamePickerQueryTests
{
    [Fact]
    public void Normalize_Trims_Text_Filters_And_Clamps_Pagination()
    {
        var query = new ArcadeGamePickerQuery
        {
            Q = "  mario  ",
            System = "  Nintendo - NES  ",
            Players = 2,
            Page = -10,
            PageSize = 999,
            Sort = ArcadeGamePickerSort.System
        };

        var normalized = query.Normalize();

        Assert.Equal("mario", normalized.Q);
        Assert.Equal("Nintendo - NES", normalized.System);
        Assert.Equal(2, normalized.Players);
        Assert.Equal(1, normalized.Page);
        Assert.Equal(50, normalized.PageSize);
        Assert.Equal(ArcadeGamePickerSort.System, normalized.Sort);
        Assert.True(normalized.HasActiveFilters);
    }

    [Fact]
    public void Normalize_Treats_Blank_And_NonPositive_Filters_As_Inactive()
    {
        var normalized = new ArcadeGamePickerQuery
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
