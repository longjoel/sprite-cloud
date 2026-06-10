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
    public DbSet<ProfileGameSave> ProfileGameSaves => Set<ProfileGameSave>();
    public DbSet<ProfileGameSaveRevision> ProfileGameSaveRevisions => Set<ProfileGameSaveRevision>();
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
    public DbSet<ProfileShareRedeemSession> ProfileShareRedeemSessions => Set<ProfileShareRedeemSession>();
    public DbSet<ProfileCorePreference> ProfileCorePreferences => Set<ProfileCorePreference>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
