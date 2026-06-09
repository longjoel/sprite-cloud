namespace games_vault.Tests;

public sealed class RoutePermissionSourceTests
{
    private static string ReadController(string fileName)
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        return File.ReadAllText(Path.Combine(repoRoot, "Controllers", fileName)).Replace("\r\n", "\n");
    }

    [Theory]
    [InlineData("GameFilesController.cs")]
    [InlineData("SystemFilesController.cs")]
    public void AdminManagementControllers_RequireAdminAccess(string controllerFile)
    {
        var content = ReadController(controllerFile);

        Assert.Contains("[ServiceFilter(typeof(AdminOnlyFilter))]", content);
        Assert.Contains("using games_vault.Web;", content);
    }

    [Fact]
    public void NosebleedTransportRoutes_UseSessionScopedPlayChecks()
    {
        var content = ReadController("SessionController.cs");

        Assert.Contains("NosebleedProxy", content);
        Assert.Contains("NosebleedWebRtcSession", content);
        Assert.Contains("currentAccess.CanPlaySessionAsync(sessionId, cancellationToken)", content);
        Assert.DoesNotContain("var canPlay = await currentAccess.CanPlayAsync(cancellationToken);\n        var seat = nosebleedSeats.Assign(sessionId", content);
    }
}
