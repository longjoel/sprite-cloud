namespace games_vault.Tests;

public sealed class JobsDetailsViewMarkupTests
{
    private static string ReadDetailsView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Jobs", "Details.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    private static string ReadJobRowsPartial()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Join(repoRoot, "Views", "Jobs", "_JobRows.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void DetailsView_ShowsJobFields()
    {
        var content = ReadDetailsView();

        Assert.Contains("Job @Model.Id", content);
        Assert.Contains("Command", content);
        Assert.Contains("Status", content);
        Assert.Contains("Attempt", content);
        Assert.Contains("Progress", content);
        Assert.Contains("Created (UTC)", content);
        Assert.Contains("Started (UTC)", content);
        Assert.Contains("Completed (UTC)", content);
    }

    [Fact]
    public void DetailsView_HasActionButtons()
    {
        var content = ReadDetailsView();

        Assert.Contains("Pause", content);
        Assert.Contains("Cancel", content);
        Assert.Contains("Re-run", content);
        Assert.Contains("Back", content);
    }

    [Fact]
    public void DetailsView_ShowsPayload()
    {
        var content = ReadDetailsView();

        Assert.Contains("Payload", content);
        Assert.Contains("@Model.PayloadJson", content);
    }

    [Fact]
    public void DetailsView_ShowsLogs()
    {
        var content = ReadDetailsView();

        Assert.Contains("Logs", content);
        Assert.Contains("jobLogs", content);
    }

    [Fact]
    public void DetailsView_ShowsLastError()
    {
        var content = ReadDetailsView();

        Assert.Contains("Last error", content);
        Assert.Contains("@Model.LastError", content);
    }

    [Fact]
    public void DetailsView_HasLogPagination()
    {
        var content = ReadDetailsView();

        Assert.Contains("pagination", content);
        Assert.Contains("Previous", content);
        Assert.Contains("Next", content);
    }

    [Fact]
    public void JobRowsPartial_HasDetailsLink()
    {
        var content = ReadJobRowsPartial();

        Assert.Contains("Details", content);
        Assert.Contains("asp-action=\"Details\"", content);
        Assert.Contains("asp-route-id", content);
    }

    [Fact]
    public void JobRowsPartial_ShowsEmptyState()
    {
        var content = ReadJobRowsPartial();

        Assert.Contains("No jobs.", content);
    }

    [Fact]
    public void JobRowsPartial_HasCheckbox()
    {
        var content = ReadJobRowsPartial();

        Assert.Contains("form-check-input job-select", content);
        Assert.Contains("data-job-id", content);
    }
}
