namespace games_vault.Tests;

public sealed class JobsIndexViewMarkupTests
{
    private static string ReadIndexView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Jobs", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void IndexView_DefinesTitleAndTable()
    {
        var content = ReadIndexView();

        Assert.Contains("Jobs", content);
        Assert.Contains("<h1 class=\"h3 mb-0\">Jobs</h1>", content);
        Assert.Contains("Status", content);
        Assert.Contains("Id", content);
        Assert.Contains("Command", content);
        Assert.Contains("Attempt", content);
        Assert.Contains("Progress", content);
        Assert.Contains("Created", content);
        Assert.Contains("Actions", content);
    }

    [Fact]
    public void IndexView_HasStatusFilter()
    {
        var content = ReadIndexView();

        Assert.Contains("id=\"jobs-status\"", content);
        Assert.Contains("All", content);
        Assert.Contains("Queued", content);
        Assert.Contains("Running", content);
        Assert.Contains("Succeeded", content);
        Assert.Contains("Failed", content);
        Assert.Contains("Canceled", content);
    }

    [Fact]
    public void IndexView_HasBulkActions()
    {
        var content = ReadIndexView();

        Assert.Contains("id=\"jobs-bulk-form\"", content);
        Assert.Contains("Clear completed", content);
        Assert.Contains("Pause selected", content);
        Assert.Contains("Cancel selected", content);
        Assert.Contains("Delete selected", content);
        Assert.Contains("Re-run selected", content);
        Assert.Contains("id=\"jobs-select-all\"", content);
    }

    [Fact]
    public void IndexView_HasPollingScript()
    {
        var content = ReadIndexView();

        Assert.Contains("function refreshRows()", content);
        Assert.Contains("/Jobs/Rows", content);
        Assert.Contains("setInterval(refreshRows, 2000)", content);
    }

    [Fact]
    public void IndexView_HasPagination()
    {
        var content = ReadIndexView();

        Assert.Contains("pagination", content);
        Assert.Contains("Previous", content);
        Assert.Contains("Next", content);
    }

    [Fact]
    public void IndexView_UsesJobRowsPartial()
    {
        var content = ReadIndexView();

        Assert.Contains("_JobRows", content);
        Assert.Contains("id=\"jobs-tbody\"", content);
    }
}
