using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;

namespace games_vault.Tests;

public sealed class RomWatchImportCommandTests : IAsyncLifetime
{
    private TestDbFixture.Scope _scope = null!;
    private AppDbContext _db = null!;

    public async Task InitializeAsync()
    {
        _scope = await TestDbFixture.CreateScopeAsync();
        _db = _scope.Db;
    }

    public async Task DisposeAsync()
    {
        if (_scope is not null)
            await _scope.DisposeAsync().AsTask();
    }

    [Fact]
    public async Task ExecuteAsync_NullPaths_LogsWarningAndReturns()
    {
        var cmd = BuildCommand();
        var job = new BackgroundJob
        {
            Command = "rom.watch",
            PayloadJson = """{"Paths":null,"TotalEnqueued":0}""",
            CreatedUtc = DateTime.UtcNow
        };
        _db.BackgroundJobs.Add(job);
        await _db.SaveChangesAsync();

        var ctx = new BackgroundJobExecutionContext(job, _db, Mock.Of<IServiceProvider>(), NullLogger.Instance);
        var payload = JsonDocument.Parse(job.PayloadJson).RootElement;

        // Should not throw
        await cmd.ExecuteAsync(ctx, payload, CancellationToken.None);
    }

    [Fact]
    public async Task ExecuteAsync_EmptyPaths_LogsWarningAndReturns()
    {
        var cmd = BuildCommand();
        var job = new BackgroundJob
        {
            Command = "rom.watch",
            PayloadJson = """{"Paths":[],"TotalEnqueued":0}""",
            CreatedUtc = DateTime.UtcNow
        };
        _db.BackgroundJobs.Add(job);
        await _db.SaveChangesAsync();

        var ctx = new BackgroundJobExecutionContext(job, _db, Mock.Of<IServiceProvider>(), NullLogger.Instance);
        var payload = JsonDocument.Parse(job.PayloadJson).RootElement;

        await cmd.ExecuteAsync(ctx, payload, CancellationToken.None);
    }

    [Fact]
    public void PayloadDeserializesCorrectly()
    {
        var payload = new RomWatchImportPayload(
            ["/roms/game1.gb", "/roms/game2.sfc"],
            TotalEnqueued: 5);

        var json = JsonSerializer.Serialize(payload);
        var deserialized = JsonSerializer.Deserialize<RomWatchImportPayload>(json, JobJson.Options);

        Assert.NotNull(deserialized);
        Assert.Equal(2, deserialized.Paths.Length);
        Assert.Equal("/roms/game1.gb", deserialized.Paths[0]);
        Assert.Equal("/roms/game2.sfc", deserialized.Paths[1]);
        Assert.Equal(5, deserialized.TotalEnqueued);
    }

    private static RomWatchImportCommand BuildCommand()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "gv-test-romwatch-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);

        var envMock = new Mock<IWebHostEnvironment>();
        envMock.Setup(x => x.ContentRootPath).Returns(tempRoot);
        envMock.Setup(x => x.WebRootPath).Returns(tempRoot);

        var storageOptions = new LibraryStorageOptions
        {
            RootPath = Path.Combine(tempRoot, "library"),
            UploadStagingRootPath = Path.Combine(tempRoot, "uploads"),
            WatchFolder = new LibraryStorageOptions.WatchFolderSettings
            {
                Enabled = true,
                Mode = WatchFolderImportMode.Link
            }
        };

        var optionsMock = new Mock<IOptions<LibraryStorageOptions>>();
        optionsMock.Setup(x => x.Value).Returns(storageOptions);

        var stagingStore = new UploadStagingStore(envMock.Object, optionsMock.Object);

        return new RomWatchImportCommand(null!, stagingStore, optionsMock.Object);
    }
}
