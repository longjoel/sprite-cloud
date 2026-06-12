using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Models;

namespace games_vault.Tests;

public sealed class GameArtBackfillPayloadTests
{
    [Fact]
    public void Payload_DefaultValues()
    {
        var payload = new GameArtBackfillPayload();
        Assert.False(payload.Force);
        Assert.Equal(100, payload.Limit);
        Assert.Null(payload.GameId);
    }

    [Fact]
    public void Payload_SerializesAndDeserializes()
    {
        var payload = new GameArtBackfillPayload(Force: true, Limit: 50, GameId: 7);
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var deserialized = JsonSerializer.Deserialize<GameArtBackfillPayload>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.NotNull(deserialized);
        Assert.True(deserialized.Force);
        Assert.Equal(50, deserialized.Limit);
        Assert.Equal(7, deserialized.GameId);
    }

    [Fact]
    public void Payload_WithForceOnly()
    {
        var payload = new GameArtBackfillPayload(Force: true);
        Assert.True(payload.Force);
        Assert.Equal(100, payload.Limit);
        Assert.Null(payload.GameId);
    }

    [Fact]
    public void Payload_WithGameIdOnly()
    {
        var payload = new GameArtBackfillPayload(GameId: 42);
        Assert.False(payload.Force);
        Assert.Equal(100, payload.Limit);
        Assert.Equal(42, payload.GameId);
    }
}

public sealed class GameArtBackfillEnqueueTests : IAsyncLifetime
{
    private readonly TestDbFixture.Scope _scope;
    private readonly AppDbContext _db;

    public GameArtBackfillEnqueueTests()
    {
        _scope = TestDbFixture.CreateScopeAsync().GetAwaiter().GetResult();
        _db = _scope.Db;
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        await _scope.DisposeAsync().AsTask();
    }

    [Fact]
    public async Task Enqueue_DefaultPayload_CreatesJob()
    {
        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("art.backfill", new GameArtBackfillPayload());

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal("art.backfill", job.Command);
        Assert.Contains("\"force\":false", job.PayloadJson);
        Assert.Contains("\"limit\":100", job.PayloadJson);
    }

    [Fact]
    public async Task Enqueue_WithForceAndGameId()
    {
        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("art.backfill", new GameArtBackfillPayload(Force: true, Limit: 25, GameId: 99));

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Contains("\"force\":true", job.PayloadJson);
        Assert.Contains("\"limit\":25", job.PayloadJson);
        Assert.Contains("\"gameId\":99", job.PayloadJson);
    }

    [Fact]
    public async Task Enqueue_LimitClampedInCommandNotInPayload()
    {
        // The payload can store any limit; the command handler clamps it
        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("art.backfill", new GameArtBackfillPayload(Limit: 9999));

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Contains("\"limit\":9999", job.PayloadJson);
    }
}

public sealed class AdminViewArtBackfillMarkupTests
{
    private static string ReadAdminView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Admin", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void AdminView_StillHasArtSection()
    {
        var content = ReadAdminView();

        Assert.Contains("id=\"admin-game-art\"", content);
        Assert.Contains("Game art", content);
    }

    [Fact]
    public void AdminView_ArtSectionHasHeading()
    {
        var content = ReadAdminView();

        Assert.Contains("Backfill art", content);
        Assert.Contains("Downloads matching libretro thumbnail art into local storage.", content);
    }

    [Fact]
    public void AdminView_ArtBackfillButtonsPresent()
    {
        var content = ReadAdminView();

        Assert.Contains("Backfill", content);
        Assert.Contains("asp-controller=\"Admin\" asp-action=\"BackfillGameArt\"", content);
        Assert.Contains("name=\"limit\"", content);
        Assert.Contains("name=\"force\"", content);
    }
}
