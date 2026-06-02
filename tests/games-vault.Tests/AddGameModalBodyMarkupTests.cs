namespace games_vault.Tests;

public sealed class AddGameModalBodyMarkupTests
{
    private static string ReadAddGameModalBodyView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Games", "_AddGameModalBody.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void UploadInput_AllowsZipAndN64Extensions_AndMentionsFilesPickerForMobile()
    {
        var content = ReadAddGameModalBodyView();

        Assert.Contains("accept=\".zip,.7z,.z64,.n64,.v64", content);
        Assert.Contains("Files</span> picker", content);
        Assert.Contains("N64 ROM files are allowed here", content);
    }
}
