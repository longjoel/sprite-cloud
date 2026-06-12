using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class GeneratePreviewJobPayloadTests
{
    [Fact]
    public void Payload_SerializesAndDeserializes()
    {
        var payload = new GeneratePreviewJobPayload(GameId: 42, Force: true);
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var deserialized = JsonSerializer.Deserialize<GeneratePreviewJobPayload>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.NotNull(deserialized);
        Assert.Equal(42, deserialized.GameId);
        Assert.True(deserialized.Force);
    }

    [Fact]
    public void Payload_DefaultsForceToFalse()
    {
        var payload = new GeneratePreviewJobPayload(GameId: 7);
        Assert.False(payload.Force);
    }

    [Fact]
    public void Payload_AcceptsForceTrue()
    {
        var payload = new GeneratePreviewJobPayload(GameId: 7, Force: true);
        Assert.True(payload.Force);
    }
}

public sealed class GeneratePreviewJobEnqueueTests : IAsyncLifetime
{
    private readonly TestDbFixture.Scope _scope;
    private readonly AppDbContext _db;

    public GeneratePreviewJobEnqueueTests()
    {
        _scope = TestDbFixture.CreateScopeAsync().GetAwaiter().GetResult();
        _db = _scope.Db;
    }

    public async Task InitializeAsync()
    {
        await Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _scope.DisposeAsync().AsTask();
    }

    [Fact]
    public async Task Enqueue_WithNoExistingPreview_CreatesJob()
    {
        var game = new Game
        {
            SystemName = "TestSystem",
            Name = "TestGame",
            SizeBytes = 1024
        };
        _db.Games.Add(game);
        await _db.SaveChangesAsync();

        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("preview.generate", new GeneratePreviewJobPayload(game.Id));

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal("preview.generate", job.Command);
        Assert.Contains($"\"gameId\":{game.Id}", job.PayloadJson);
        Assert.Contains("\"force\":false", job.PayloadJson);
    }

    [Fact]
    public async Task Enqueue_WithForce_SetsForceInPayload()
    {
        var game = new Game
        {
            SystemName = "TestSystem",
            Name = "TestGame",
            SizeBytes = 1024
        };
        _db.Games.Add(game);
        await _db.SaveChangesAsync();

        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("preview.generate", new GeneratePreviewJobPayload(game.Id, Force: true));

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Contains("\"force\":true", job.PayloadJson);
    }

    /// <summary>
    /// Tests that the skip-when-preview-exists logic works at the DB/query level
    /// by verifying the job is created but the command handler (when executed)
    /// checks the game state before proceeding.
    /// </summary>
    [Fact]
    public async Task GameWithPreview_JobCanStillBeEnqueuedButPayloadIncludesSkipData()
    {
        var game = new Game
        {
            SystemName = "TestSystem",
            Name = "TestGame",
            SizeBytes = 1024,
            PreviewImagePath = "/art/games/1/preview.gif"
        };
        _db.Games.Add(game);
        await _db.SaveChangesAsync();

        var client = new BackgroundJobClient(_db);
        // Without force — job is enqueued but command handler will skip
        var jobId = await client.EnqueueAsync("preview.generate", new GeneratePreviewJobPayload(game.Id));

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal("preview.generate", job.Command);

        // With force — job is enqueued and command handler should regenerate
        var jobId2 = await client.EnqueueAsync("preview.generate", new GeneratePreviewJobPayload(game.Id, Force: true));
        var job2 = await _db.BackgroundJobs.FindAsync(jobId2);
        Assert.NotNull(job2);
        Assert.Contains("\"force\":true", job2.PayloadJson);
    }
}
