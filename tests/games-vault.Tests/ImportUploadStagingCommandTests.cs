using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using Npgsql;

namespace games_vault.Tests;

public sealed class ImportUploadStagingCommandTests : IAsyncLifetime
{
    private readonly TestDbFixture.Scope _scope;
    private readonly AppDbContext _db;

    public ImportUploadStagingCommandTests()
    {
        _scope = TestDbFixture.CreateScopeAsync().GetAwaiter().GetResult();
        _db = _scope.Db;
    }

    public async Task InitializeAsync() { await Task.CompletedTask; }
    public async Task DisposeAsync() => await _scope.DisposeAsync().AsTask();

    [Fact]
    public async Task ExecuteAsync_EmptyPayload_Throws()
    {
        var cmd = BuildCommand();
        var job = new BackgroundJob
        {
            Command = "upload.import",
            PayloadJson = """{"StagingDirectory":""}""",
            CreatedUtc = DateTime.UtcNow
        };
        _db.BackgroundJobs.Add(job);
        await _db.SaveChangesAsync();

        var ctx = new BackgroundJobExecutionContext(job, _db, Mock.Of<IServiceProvider>(), NullLogger.Instance);

        var payload = JsonDocument.Parse(job.PayloadJson).RootElement;
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            cmd.ExecuteAsync(ctx, payload, CancellationToken.None));
        Assert.Contains("staging directory", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static ImportUploadStagingCommand BuildCommand()
    {
        var webHostMock = new Mock<IWebHostEnvironment>();
        webHostMock.Setup(x => x.ContentRootPath).Returns(Directory.GetCurrentDirectory());
        webHostMock.Setup(x => x.WebRootPath).Returns(Path.Combine(Directory.GetCurrentDirectory(), "wwwroot"));

        var optionsMock = new Mock<IOptions<LibraryStorageOptions>>();
        optionsMock.Setup(x => x.Value).Returns(new LibraryStorageOptions());

        var stagingStore = new UploadStagingStore(webHostMock.Object, optionsMock.Object);

        // GameUploadImporter is sealed; the command validates payload before reaching it.
        // The real import logic is tested in LibretroZipImportTests.
        return new ImportUploadStagingCommand(null!, stagingStore);
    }
}
