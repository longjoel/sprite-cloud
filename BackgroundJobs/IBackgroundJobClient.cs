using System.Text.Json;
using games_vault.Data;
using games_vault.Models;

namespace games_vault.BackgroundJobs;

public interface IBackgroundJobClient
{
    Task<int> EnqueueAsync(string commandName, object payload, int? maxAttempts = null, CancellationToken cancellationToken = default);
}

public sealed class BackgroundJobClient(AppDbContext db) : IBackgroundJobClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<int> EnqueueAsync(string commandName, object payload, int? maxAttempts = null, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(commandName))
        {
            throw new ArgumentException("Command name is required.", nameof(commandName));
        }

        var job = new BackgroundJob
        {
            Command = commandName.Trim(),
            PayloadJson = JsonSerializer.Serialize(payload, JsonOptions),
            MaxAttempts = maxAttempts ?? 3,
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };

        db.BackgroundJobs.Add(job);
        await db.SaveChangesAsync(cancellationToken);
        return job.Id;
    }
}
