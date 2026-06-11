using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Tests;

public sealed class ProfileGameSaveSchemaTests
{
    [Fact]
    public async Task EnsureCreated_allows_profile_game_save_with_multiple_revisions_and_latest_pointer()
    {
        await using var fixture = await CreateFixtureAsync();

        var profile = new UserProfile
        {
            DisplayName = "Joel",
            Username = "joel",
            Color = "#198754",
            PasskeyUserHandleBase64Url = "handle-1",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };

        var game = new Game
        {
            Name = "Sonic the Hedgehog",
            SystemName = "Sega - Mega Drive - Genesis",
            SizeBytes = 1,
            CreatedUtc = DateTime.UtcNow
        };

        fixture.Db.UserProfiles.Add(profile);
        fixture.Db.Games.Add(game);
        await fixture.Db.SaveChangesAsync();

        var file = new GameFile
        {
            GameId = game.Id,
            Name = "sonic.bin",
            SizeBytes = 1,
            StoragePath = "roms/genesis/sonic.bin"
        };
        fixture.Db.GameFiles.Add(file);
        await fixture.Db.SaveChangesAsync();

        var save = new ProfileGameSave
        {
            ProfileId = profile.Id,
            GameId = game.Id,
            GameFileId = file.Id,
            SystemName = game.SystemName,
            CoreKey = "genesis_plus_gx",
            Kind = "battery",
            Key = "default",
            FileName = "sonic.srm",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        fixture.Db.ProfileGameSaves.Add(save);
        await fixture.Db.SaveChangesAsync();

        var firstRevision = new ProfileGameSaveRevision
        {
            ProfileGameSaveId = save.Id,
            RevisionTimestampUtc = DateTime.UtcNow.AddMinutes(-2),
            StoragePath = "profile-saves/profiles/1/games/1/files/1/battery/1/20260602T230000Z-deadbeef.srm",
            SizeBytes = 1024,
            Sha256 = new string('a', 64),
            Source = "runtime",
            CreatedUtc = DateTime.UtcNow.AddMinutes(-2)
        };

        var secondRevision = new ProfileGameSaveRevision
        {
            ProfileGameSaveId = save.Id,
            RevisionTimestampUtc = DateTime.UtcNow,
            StoragePath = "profile-saves/profiles/1/games/1/files/1/battery/1/20260602T231000Z-feedface.srm",
            SizeBytes = 2048,
            Sha256 = new string('b', 64),
            Source = "upload",
            OriginalUploadFileName = "sonic.srm",
            CreatedUtc = DateTime.UtcNow
        };

        fixture.Db.ProfileGameSaveRevisions.AddRange(firstRevision, secondRevision);
        await fixture.Db.SaveChangesAsync();

        save.LatestRevisionId = secondRevision.Id;
        save.UpdatedUtc = DateTime.UtcNow;
        await fixture.Db.SaveChangesAsync();

        var stored = await fixture.Db.ProfileGameSaves
            .Include(x => x.Profile)
            .Include(x => x.Game)
            .Include(x => x.GameFile)
            .Include(x => x.LatestRevision)
            .Include(x => x.Revisions.OrderBy(r => r.RevisionTimestampUtc))
            .SingleAsync();

        Assert.Equal(profile.Id, stored.ProfileId);
        Assert.Equal(game.Id, stored.GameId);
        Assert.Equal(file.Id, stored.GameFileId);
        Assert.Equal("battery", stored.Kind);
        Assert.Equal(secondRevision.Id, stored.LatestRevisionId);
        Assert.Equal("upload", stored.LatestRevision!.Source);
        Assert.Equal(2, stored.Revisions.Count);
        Assert.Equal(firstRevision.Id, stored.Revisions.First().Id);
        Assert.Equal(secondRevision.Id, stored.Revisions.Last().Id);
    }

    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var scope = await TestDbFixture.CreateScopeAsync();
        var db = scope.Db;
        return new TestFixture(scope, db);
    }

    private sealed record TestFixture(TestDbFixture.Scope Scope, AppDbContext Db) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Scope.DisposeAsync();
        }
    }
}
