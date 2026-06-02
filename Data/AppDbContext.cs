using games_vault.Models;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Game> Games => Set<Game>();
    public DbSet<GameFile> GameFiles => Set<GameFile>();
    public DbSet<SystemFile> SystemFiles => Set<SystemFile>();
    public DbSet<BackgroundJob> BackgroundJobs => Set<BackgroundJob>();
    public DbSet<BackgroundJobLogEntry> BackgroundJobLogEntries => Set<BackgroundJobLogEntry>();
    public DbSet<GameBatch> GameBatches => Set<GameBatch>();
    public DbSet<GameBatchItem> GameBatchItems => Set<GameBatchItem>();
    public DbSet<Artifact> Artifacts => Set<Artifact>();
    public DbSet<NetworkShare> NetworkShares => Set<NetworkShare>();
    public DbSet<NetworkScanRun> NetworkScanRuns => Set<NetworkScanRun>();
    public DbSet<NetworkScanResult> NetworkScanResults => Set<NetworkScanResult>();
    public DbSet<WebSource> WebSources => Set<WebSource>();
    public DbSet<WebScanRun> WebScanRuns => Set<WebScanRun>();
    public DbSet<WebScanResult> WebScanResults => Set<WebScanResult>();
    public DbSet<LocalFolder> LocalFolders => Set<LocalFolder>();
    public DbSet<LocalScanRun> LocalScanRuns => Set<LocalScanRun>();
    public DbSet<LocalScanResult> LocalScanResults => Set<LocalScanResult>();
    public DbSet<GamePlayerFile> GamePlayerFiles => Set<GamePlayerFile>();
    public DbSet<GamePlaySession> GamePlaySessions => Set<GamePlaySession>();
    public DbSet<global::games_vault.Models.Arcade> Arcades => Set<global::games_vault.Models.Arcade>();
    public DbSet<ArcadeCabinet> ArcadeCabinets => Set<ArcadeCabinet>();
    public DbSet<SystemCoreMapping> SystemCoreMappings => Set<SystemCoreMapping>();
    public DbSet<UserProfile> UserProfiles => Set<UserProfile>();
    public DbSet<UserProfilePasskey> UserProfilePasskeys => Set<UserProfilePasskey>();
    public DbSet<ProfileInviteCode> ProfileInviteCodes => Set<ProfileInviteCode>();
    public DbSet<ProfileShareLink> ProfileShareLinks => Set<ProfileShareLink>();
    public DbSet<GamePlayRoom> GamePlayRooms => Set<GamePlayRoom>();
    public DbSet<GamePlayRoomParticipant> GamePlayRoomParticipants => Set<GamePlayRoomParticipant>();
    public DbSet<GamePlayRoomChatMessage> GamePlayRoomChatMessages => Set<GamePlayRoomChatMessage>();
    public DbSet<ProfileAuthSession> ProfileAuthSessions => Set<ProfileAuthSession>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Game>(entity =>
        {
            entity.Property(x => x.SystemName).HasMaxLength(100);
            entity.Property(x => x.Name).HasMaxLength(200);
            entity.Property(x => x.Crc32).HasMaxLength(8);
            entity.Property(x => x.Genre).HasMaxLength(100);
            entity.Property(x => x.CriticGenre).HasMaxLength(100);
            entity.Property(x => x.CriticRating).HasPrecision(5, 2);
            entity.Property(x => x.UserRating).HasPrecision(5, 2);
        });

        modelBuilder.Entity<GameFile>(entity =>
        {
            entity.Property(x => x.Name).HasMaxLength(260);
            entity.Property(x => x.OriginalFileName).HasMaxLength(260);
            entity.Property(x => x.Crc32).HasMaxLength(8);
            entity.Property(x => x.StoragePath).HasMaxLength(1000);
            entity.Property(x => x.ExternalPath).HasMaxLength(2000);

            entity.HasOne(x => x.Game)
                .WithMany(x => x.Files)
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<SystemFile>(entity =>
        {
            entity.Property(x => x.SystemName).HasMaxLength(100);
            entity.Property(x => x.Kind).HasMaxLength(30);
            entity.Property(x => x.FileName).HasMaxLength(260);
            entity.Property(x => x.TargetPath).HasMaxLength(500);
            entity.Property(x => x.OriginalFileName).HasMaxLength(260);
            entity.Property(x => x.Crc32).HasMaxLength(8);
            entity.Property(x => x.StoragePath).HasMaxLength(1000);
        });

        modelBuilder.Entity<BackgroundJob>(entity =>
        {
            entity.Property(x => x.Command).HasMaxLength(200);
            entity.Property(x => x.LockedBy).HasMaxLength(100);
        });

        modelBuilder.Entity<BackgroundJobLogEntry>(entity =>
        {
            entity.Property(x => x.Level).HasMaxLength(20);
            entity.Property(x => x.Message).HasMaxLength(4000);

            entity.HasOne(x => x.BackgroundJob)
                .WithMany()
                .HasForeignKey(x => x.BackgroundJobId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<GameBatch>(entity =>
        {
            entity.Property(x => x.Name).HasMaxLength(100);
        });

        modelBuilder.Entity<GameBatchItem>(entity =>
        {
            entity.HasKey(x => new { x.GameBatchId, x.GameId });

            entity.HasOne(x => x.GameBatch)
                .WithMany(x => x.Items)
                .HasForeignKey(x => x.GameBatchId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.Game)
                .WithMany()
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Artifact>(entity =>
        {
            entity.Property(x => x.FileName).HasMaxLength(260);
            entity.Property(x => x.StoragePath).HasMaxLength(1000);
            entity.Property(x => x.ContentType).HasMaxLength(200);
            entity.Property(x => x.Source).HasMaxLength(200);
        });

        modelBuilder.Entity<NetworkShare>(entity =>
        {
            entity.Property(x => x.Name).HasMaxLength(100);
            entity.Property(x => x.RootPath).HasMaxLength(500);
            entity.Property(x => x.Username).HasMaxLength(200);
            entity.Property(x => x.Password).HasMaxLength(500);
        });

        modelBuilder.Entity<NetworkScanRun>(entity =>
        {
            entity.HasOne(x => x.NetworkShare)
                .WithMany()
                .HasForeignKey(x => x.NetworkShareId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.BackgroundJob)
                .WithMany()
                .HasForeignKey(x => x.BackgroundJobId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<NetworkScanResult>(entity =>
        {
            entity.Property(x => x.FullPath).HasMaxLength(1000);
            entity.Property(x => x.FileName).HasMaxLength(260);

            entity.HasOne(x => x.NetworkScanRun)
                .WithMany()
                .HasForeignKey(x => x.NetworkScanRunId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<WebSource>(entity =>
        {
            entity.Property(x => x.Name).HasMaxLength(100);
            entity.Property(x => x.IndexUrl).HasMaxLength(1000);
            entity.Property(x => x.AllowedExtensions).HasMaxLength(500);
        });

        modelBuilder.Entity<WebScanRun>(entity =>
        {
            entity.HasOne(x => x.WebSource)
                .WithMany()
                .HasForeignKey(x => x.WebSourceId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.BackgroundJob)
                .WithMany()
                .HasForeignKey(x => x.BackgroundJobId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<WebScanResult>(entity =>
        {
            entity.Property(x => x.Url).HasMaxLength(1000);
            entity.Property(x => x.FileName).HasMaxLength(260);

            entity.HasOne(x => x.WebScanRun)
                .WithMany()
                .HasForeignKey(x => x.WebScanRunId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<LocalFolder>(entity =>
        {
            entity.Property(x => x.Name).HasMaxLength(100);
            entity.Property(x => x.RootPath).HasMaxLength(500);
        });

        modelBuilder.Entity<LocalScanRun>(entity =>
        {
            entity.HasOne(x => x.LocalFolder)
                .WithMany()
                .HasForeignKey(x => x.LocalFolderId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.BackgroundJob)
                .WithMany()
                .HasForeignKey(x => x.BackgroundJobId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<LocalScanResult>(entity =>
        {
            entity.Property(x => x.FullPath).HasMaxLength(1000);
            entity.Property(x => x.FileName).HasMaxLength(260);

            entity.HasOne(x => x.LocalScanRun)
                .WithMany()
                .HasForeignKey(x => x.LocalScanRunId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<GamePlayerFile>(entity =>
        {
            entity.Property(x => x.Kind).HasMaxLength(50);
            entity.Property(x => x.Key).HasMaxLength(100);
            entity.Property(x => x.FileName).HasMaxLength(260);
            entity.Property(x => x.StoragePath).HasMaxLength(1000);

            entity.HasOne(x => x.Game)
                .WithMany()
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasIndex(x => new { x.GameId, x.Kind, x.Key, x.FileName }).IsUnique();
        });

        modelBuilder.Entity<global::games_vault.Models.Arcade>(entity =>
        {
            entity.Property(x => x.Name).HasMaxLength(120);
            entity.Property(x => x.Slug).HasMaxLength(120);
            entity.Property(x => x.Description).HasMaxLength(1000);
            entity.HasIndex(x => x.Slug).IsUnique();
        });

        modelBuilder.Entity<ArcadeCabinet>(entity =>
        {
            entity.Property(x => x.DisplayName).HasMaxLength(120);
            entity.Property(x => x.RuntimeSessionId).HasMaxLength(200);
            entity.Property(x => x.LastError).HasMaxLength(1000);

            entity.HasOne(x => x.Arcade)
                .WithMany(x => x.Cabinets)
                .HasForeignKey(x => x.ArcadeId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.Game)
                .WithMany()
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.GameFile)
                .WithMany()
                .HasForeignKey(x => x.GameFileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasIndex(x => new { x.ArcadeId, x.SortOrder });
            entity.HasIndex(x => x.RuntimeSessionId);
        });

        modelBuilder.Entity<SystemCoreMapping>(entity =>
        {
            entity.Property(x => x.SystemName).HasMaxLength(100);
            entity.Property(x => x.NativeCoreFileName).HasMaxLength(260);
            entity.Property(x => x.WebPlayerCoreKey).HasMaxLength(100);
            entity.Property(x => x.Notes).HasMaxLength(1000);
            entity.HasIndex(x => x.SystemName).IsUnique();
        });

        modelBuilder.Entity<UserProfile>(entity =>
        {
            entity.Property(x => x.DisplayName).HasMaxLength(80);
            entity.Property(x => x.Username).HasMaxLength(32);
            entity.Property(x => x.AvatarKey).HasMaxLength(32);
            entity.Property(x => x.Color).HasMaxLength(20);
            entity.Property(x => x.PasskeyUserHandleBase64Url).HasMaxLength(128);
            entity.Property(x => x.PasswordHash).HasMaxLength(256);
            entity.HasIndex(x => x.DisplayName);
            entity.HasIndex(x => x.Username).IsUnique();
            entity.HasIndex(x => x.PasskeyUserHandleBase64Url).IsUnique();
            entity.HasIndex(x => x.ParentProfileId);
            entity.HasIndex(x => x.CreatedFromShareLinkId);

            entity.HasOne(x => x.ParentProfile)
                .WithMany()
                .HasForeignKey(x => x.ParentProfileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasOne(x => x.CreatedFromShareLink)
                .WithMany()
                .HasForeignKey(x => x.CreatedFromShareLinkId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<ProfileInviteCode>(entity =>
        {
            entity.Property(x => x.Code).HasMaxLength(64);
            entity.HasIndex(x => x.Code).IsUnique();

            entity.HasOne(x => x.UsedByProfile)
                .WithMany()
                .HasForeignKey(x => x.UsedByProfileId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<ProfileShareLink>(entity =>
        {
            entity.Property(x => x.TokenHash).HasMaxLength(128);
            entity.HasIndex(x => x.TokenHash).IsUnique();
            entity.HasIndex(x => new { x.RoomId, x.CreatedUtc });
            entity.HasIndex(x => new { x.ParentProfileId, x.CreatedUtc });

            entity.HasOne(x => x.Room)
                .WithMany()
                .HasForeignKey(x => x.RoomId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.Game)
                .WithMany()
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.CreatedByProfile)
                .WithMany()
                .HasForeignKey(x => x.CreatedByProfileId)
                .OnDelete(DeleteBehavior.Restrict);

            entity.HasOne(x => x.ParentProfile)
                .WithMany()
                .HasForeignKey(x => x.ParentProfileId)
                .OnDelete(DeleteBehavior.Restrict);

            entity.HasOne(x => x.RedeemedByProfile)
                .WithMany()
                .HasForeignKey(x => x.RedeemedByProfileId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<UserProfilePasskey>(entity =>
        {
            entity.Property(x => x.CredentialIdBase64Url).HasMaxLength(512);
            entity.Property(x => x.UserHandleBase64Url).HasMaxLength(128);
            entity.Property(x => x.DeviceName).HasMaxLength(200);
            entity.HasIndex(x => x.CredentialIdBase64Url).IsUnique();
            entity.HasIndex(x => x.UserHandleBase64Url);

            entity.HasOne(x => x.Profile)
                .WithMany()
                .HasForeignKey(x => x.ProfileId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<GamePlaySession>(entity =>
        {
            entity.Property(x => x.Mode).HasMaxLength(40);
            entity.Property(x => x.ExternalSessionId).HasMaxLength(200);
            entity.Property(x => x.EndReason).HasMaxLength(100);

            entity.HasOne(x => x.Game)
                .WithMany()
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.GameFile)
                .WithMany()
                .HasForeignKey(x => x.GameFileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasOne(x => x.Profile)
                .WithMany()
                .HasForeignKey(x => x.ProfileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasIndex(x => new { x.GameId, x.StartedUtc });
            entity.HasIndex(x => x.ExternalSessionId);
            entity.HasIndex(x => new { x.Mode, x.StartedUtc });
            entity.HasIndex(x => new { x.ProfileId, x.StartedUtc });
        });

        modelBuilder.Entity<GamePlayRoom>(entity =>
        {
            entity.Property(x => x.Code).HasMaxLength(4);
            entity.Property(x => x.NosebleedSessionId).HasMaxLength(200);

            entity.HasOne(x => x.Game)
                .WithMany()
                .HasForeignKey(x => x.GameId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.GameFile)
                .WithMany()
                .HasForeignKey(x => x.GameFileId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.CreatedByProfile)
                .WithMany()
                .HasForeignKey(x => x.CreatedByProfileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasOne(x => x.ArcadeCabinet)
                .WithMany()
                .HasForeignKey(x => x.ArcadeCabinetId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasIndex(x => new { x.Code, x.Status }).IsUnique();
            entity.HasIndex(x => x.NosebleedSessionId);
            entity.HasIndex(x => new { x.GameId, x.GameFileId, x.Status });
        });

        modelBuilder.Entity<GamePlayRoomParticipant>(entity =>
        {
            entity.Property(x => x.ViewerId).HasMaxLength(64);
            entity.Property(x => x.DisplayNameSnapshot).HasMaxLength(80);

            entity.HasOne(x => x.Room)
                .WithMany(x => x.Participants)
                .HasForeignKey(x => x.RoomId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.Profile)
                .WithMany()
                .HasForeignKey(x => x.ProfileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasIndex(x => new { x.RoomId, x.ViewerId }).IsUnique();
            entity.HasIndex(x => new { x.RoomId, x.IsConnected });
        });

        modelBuilder.Entity<GamePlayRoomChatMessage>(entity =>
        {
            entity.Property(x => x.DisplayNameSnapshot).HasMaxLength(80);
            entity.Property(x => x.Message).HasMaxLength(280);

            entity.HasOne(x => x.Room)
                .WithMany(x => x.ChatMessages)
                .HasForeignKey(x => x.RoomId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(x => x.Profile)
                .WithMany()
                .HasForeignKey(x => x.ProfileId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasIndex(x => new { x.RoomId, x.CreatedUtc });
        });

        modelBuilder.Entity<ProfileAuthSession>(entity =>
        {
            entity.Property(x => x.SessionNonce).HasMaxLength(64);
            entity.Property(x => x.UserAgentHash).HasMaxLength(128);

            entity.HasOne(x => x.Profile)
                .WithMany()
                .HasForeignKey(x => x.ProfileId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasIndex(x => x.SessionNonce).IsUnique();
            entity.HasIndex(x => x.ProfileId)
                .HasFilter("\"RevokedUtc\" IS NULL")
                .IsUnique();
            entity.HasIndex(x => new { x.ProfileId, x.RevokedUtc });
        });
    }
}
