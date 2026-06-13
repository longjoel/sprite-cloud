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

public sealed class ValidationRunCommandTests : IAsyncLifetime
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
    public async Task ExecuteAsync_NullPayload_LogsWarningAndReturns()
    {
        var cmd = BuildCommand();
        var job = new BackgroundJob
        {
            Command = "validation.run",
            PayloadJson = "null",
            CreatedUtc = DateTime.UtcNow
        };
        _db.BackgroundJobs.Add(job);
        await _db.SaveChangesAsync();

        var ctx = new BackgroundJobExecutionContext(job, _db, Mock.Of<IServiceProvider>(), NullLogger.Instance);
        var payload = JsonDocument.Parse(job.PayloadJson).RootElement;

        await cmd.ExecuteAsync(ctx, payload, CancellationToken.None);
    }

    [Fact]
    public async Task ExecuteAsync_EmptyDb_RunsCleanly()
    {
        var cmd = BuildCommand(_db);
        var job = new BackgroundJob
        {
            Command = "validation.run",
            PayloadJson = """{"ValidateCores":true,"ValidateSystemFiles":true}""",
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
        var payload = new ValidationRunPayload(ValidateCores: true, ValidateSystemFiles: false);
        var json = JsonSerializer.Serialize(payload);
        var deserialized = JsonSerializer.Deserialize<ValidationRunPayload>(json, JobJson.Options);

        Assert.NotNull(deserialized);
        Assert.True(deserialized.ValidateCores);
        Assert.False(deserialized.ValidateSystemFiles);
    }

    private ValidationRunCommand BuildCommand(AppDbContext? db = null)
    {
        var nosebleedMock = new Mock<IOptions<Nosebleed.NosebleedOptions>>();
        nosebleedMock.Setup(x => x.Value).Returns(new Nosebleed.NosebleedOptions
        {
            CoreRoot = "/nonexistent/cores"
        });

        var envMock = new Mock<IWebHostEnvironment>();
        envMock.Setup(x => x.ContentRootPath).Returns(Directory.GetCurrentDirectory());

        var storageOptionsMock = new Mock<IOptions<LibraryStorageOptions>>();
        storageOptionsMock.Setup(x => x.Value).Returns(new LibraryStorageOptions());

        var storage = new SystemFileStorage(envMock.Object, storageOptionsMock.Object);

        return new ValidationRunCommand(db ?? null!, nosebleedMock.Object, storage);
    }
}
