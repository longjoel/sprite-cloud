using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class InitialPostgres : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Arcades",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Slug = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    IsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Arcades", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Artifacts",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    StoragePath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    ContentType = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Source = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Artifacts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GameBatches",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GameBatches", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Games",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SystemName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Crc32 = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    ReleaseDate = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    NumberOfPlayers = table.Column<int>(type: "integer", nullable: true),
                    Genre = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CriticRating = table.Column<decimal>(type: "numeric(5,2)", precision: 5, scale: 2, nullable: true),
                    UserRating = table.Column<decimal>(type: "numeric(5,2)", precision: 5, scale: 2, nullable: true),
                    CriticGenre = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Games", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LocalFolders",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    RootPath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LocalFolders", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LocalScanResults",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    FullPath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    LastWriteUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LocalScanResults", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "NetworkScanResults",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    FullPath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    LastWriteUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NetworkScanResults", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "NetworkShares",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    RootPath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Username = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Password = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NetworkShares", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SystemFiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SystemName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Kind = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    TargetPath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    OriginalFileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: true),
                    Crc32 = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    StoragePath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SystemFiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WebScanResults",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Url = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: true),
                    LastModifiedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WebScanResults", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WebSources",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    IndexUrl = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    AllowedExtensions = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WebSources", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GameBatchItems",
                columns: table => new
                {
                    GameBatchId = table.Column<int>(type: "integer", nullable: false),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    AddedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GameBatchItems", x => new { x.GameBatchId, x.GameId });
                    table.ForeignKey(
                        name: "FK_GameBatchItems_GameBatches_GameBatchId",
                        column: x => x.GameBatchId,
                        principalTable: "GameBatches",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_GameBatchItems_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GameFiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    Name = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    OriginalFileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: true),
                    Crc32 = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    StoragePath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    ExternalPath = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GameFiles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GameFiles_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GamePlayerFiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    Kind = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    StoragePath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlayerFiles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GamePlayerFiles_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ArcadeCabinets",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ArcadeId = table.Column<int>(type: "integer", nullable: false),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    GameFileId = table.Column<int>(type: "integer", nullable: true),
                    DisplayName = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    IsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    AutoRestart = table.Column<bool>(type: "boolean", nullable: false),
                    CreditMode = table.Column<int>(type: "integer", nullable: false),
                    TokenCostPerCredit = table.Column<int>(type: "integer", nullable: false),
                    RuntimeSessionId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    LastStartedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastSeenAliveUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ArcadeCabinets", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ArcadeCabinets_Arcades_ArcadeId",
                        column: x => x.ArcadeId,
                        principalTable: "Arcades",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ArcadeCabinets_GameFiles_GameFileId",
                        column: x => x.GameFileId,
                        principalTable: "GameFiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_ArcadeCabinets_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GamePlayRoomChatMessages",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    RoomId = table.Column<int>(type: "integer", nullable: false),
                    ProfileId = table.Column<int>(type: "integer", nullable: true),
                    DisplayNameSnapshot = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    Message = table.Column<string>(type: "character varying(280)", maxLength: 280, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlayRoomChatMessages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GamePlayRoomParticipants",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    RoomId = table.Column<int>(type: "integer", nullable: false),
                    ViewerId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ProfileId = table.Column<int>(type: "integer", nullable: true),
                    DisplayNameSnapshot = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    Role = table.Column<int>(type: "integer", nullable: false),
                    Port = table.Column<int>(type: "integer", nullable: true),
                    JoinedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastSeenUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    IsConnected = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlayRoomParticipants", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GamePlayRooms",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Code = table.Column<string>(type: "character varying(6)", maxLength: 6, nullable: false),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    GameFileId = table.Column<int>(type: "integer", nullable: false),
                    NosebleedSessionId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CreatedByProfileId = table.Column<int>(type: "integer", nullable: true),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastActiveUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ClosedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    IsArcadeBound = table.Column<bool>(type: "boolean", nullable: false),
                    ArcadeCabinetId = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlayRooms", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GamePlayRooms_ArcadeCabinets_ArcadeCabinetId",
                        column: x => x.ArcadeCabinetId,
                        principalTable: "ArcadeCabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_GamePlayRooms_GameFiles_GameFileId",
                        column: x => x.GameFileId,
                        principalTable: "GameFiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_GamePlayRooms_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GamePlaySessions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    GameFileId = table.Column<int>(type: "integer", nullable: true),
                    Mode = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    ExternalSessionId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    StartedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DurationSeconds = table.Column<int>(type: "integer", nullable: false),
                    EndReason = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ProfileId = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlaySessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GamePlaySessions_GameFiles_GameFileId",
                        column: x => x.GameFileId,
                        principalTable: "GameFiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_GamePlaySessions_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ProfileAuthSessions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileId = table.Column<int>(type: "integer", nullable: false),
                    SessionNonce = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserAgentHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    LastSeenUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    RevokedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ConcurrencyToken = table.Column<byte[]>(type: "bytea", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileAuthSessions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProfileCorePreferences",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileId = table.Column<int>(type: "integer", nullable: false),
                    SystemName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    CorePath = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: true),
                    CoreKey = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileCorePreferences", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProfileGameSaveRevisions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileGameSaveId = table.Column<int>(type: "integer", nullable: false),
                    GamePlaySessionId = table.Column<int>(type: "integer", nullable: true),
                    RevisionTimestampUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    StoragePath = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    Sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Source = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    OriginalUploadFileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileGameSaveRevisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaveRevisions_GamePlaySessions_GamePlaySessionId",
                        column: x => x.GamePlaySessionId,
                        principalTable: "GamePlaySessions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "ProfileGameSaves",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileId = table.Column<int>(type: "integer", nullable: false),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    GameFileId = table.Column<int>(type: "integer", nullable: false),
                    SystemName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    CoreKey = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    Kind = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    FileName = table.Column<string>(type: "character varying(260)", maxLength: 260, nullable: false),
                    LatestRevisionId = table.Column<int>(type: "integer", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileGameSaves", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                        column: x => x.GameFileId,
                        principalTable: "GameFiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_ProfileGameSaveRevisions_LatestRevisionId",
                        column: x => x.LatestRevisionId,
                        principalTable: "ProfileGameSaveRevisions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ProfileInviteCodes",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Code = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UsedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UsedByProfileId = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileInviteCodes", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProfilePinnedGames",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileId = table.Column<int>(type: "integer", nullable: false),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    IsArchived = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfilePinnedGames", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfilePinnedGames_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ProfileShareLinks",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    TokenHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    RoomId = table.Column<int>(type: "integer", nullable: false),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    CreatedByProfileId = table.Column<int>(type: "integer", nullable: false),
                    ParentProfileId = table.Column<int>(type: "integer", nullable: false),
                    GrantMode = table.Column<int>(type: "integer", nullable: false),
                    MaxUses = table.Column<int>(type: "integer", nullable: false),
                    UseCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RevokedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RedeemedByProfileId = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileShareLinks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_GamePlayRooms_RoomId",
                        column: x => x.RoomId,
                        principalTable: "GamePlayRooms",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ProfileShareRedeemSessions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileShareLinkId = table.Column<int>(type: "integer", nullable: false),
                    SessionCode = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ConsumedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileShareRedeemSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileShareRedeemSessions_ProfileShareLinks_ProfileShareLi~",
                        column: x => x.ProfileShareLinkId,
                        principalTable: "ProfileShareLinks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "UserProfiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DisplayName = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Username = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    AvatarKey = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    Bio = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Color = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    PasskeyUserHandleBase64Url = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    PasswordHash = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    ParentProfileId = table.Column<int>(type: "integer", nullable: true),
                    IsEphemeral = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedFromShareLinkId = table.Column<int>(type: "integer", nullable: true),
                    FailedLoginAttempts = table.Column<int>(type: "integer", nullable: false),
                    LoginLockoutUntilUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    IsArchived = table.Column<bool>(type: "boolean", nullable: false),
                    IsAdmin = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserProfiles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UserProfiles_ProfileShareLinks_CreatedFromShareLinkId",
                        column: x => x.CreatedFromShareLinkId,
                        principalTable: "ProfileShareLinks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_UserProfiles_UserProfiles_ParentProfileId",
                        column: x => x.ParentProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "UserProfilePasskeys",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProfileId = table.Column<int>(type: "integer", nullable: false),
                    CredentialIdBase64Url = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    PublicKey = table.Column<byte[]>(type: "bytea", nullable: false),
                    UserHandleBase64Url = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    SignatureCounter = table.Column<long>(type: "bigint", nullable: false),
                    DeviceName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserProfilePasskeys", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UserProfilePasskeys_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ArcadeCabinets_ArcadeId_SortOrder",
                table: "ArcadeCabinets",
                columns: new[] { "ArcadeId", "SortOrder" });

            migrationBuilder.CreateIndex(
                name: "IX_ArcadeCabinets_GameFileId",
                table: "ArcadeCabinets",
                column: "GameFileId");

            migrationBuilder.CreateIndex(
                name: "IX_ArcadeCabinets_GameId",
                table: "ArcadeCabinets",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_ArcadeCabinets_RuntimeSessionId",
                table: "ArcadeCabinets",
                column: "RuntimeSessionId");

            migrationBuilder.CreateIndex(
                name: "IX_Arcades_Slug",
                table: "Arcades",
                column: "Slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GameBatchItems_GameId",
                table: "GameBatchItems",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_GameFiles_Crc32",
                table: "GameFiles",
                column: "Crc32");

            migrationBuilder.CreateIndex(
                name: "IX_GameFiles_GameId",
                table: "GameFiles",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayerFiles_GameId_Kind_Key_FileName",
                table: "GamePlayerFiles",
                columns: new[] { "GameId", "Kind", "Key", "FileName" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRoomChatMessages_ProfileId",
                table: "GamePlayRoomChatMessages",
                column: "ProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRoomChatMessages_RoomId_CreatedUtc",
                table: "GamePlayRoomChatMessages",
                columns: new[] { "RoomId", "CreatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRoomParticipants_ProfileId",
                table: "GamePlayRoomParticipants",
                column: "ProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRoomParticipants_RoomId_IsConnected",
                table: "GamePlayRoomParticipants",
                columns: new[] { "RoomId", "IsConnected" });

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRoomParticipants_RoomId_ViewerId",
                table: "GamePlayRoomParticipants",
                columns: new[] { "RoomId", "ViewerId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRooms_ArcadeCabinetId",
                table: "GamePlayRooms",
                column: "ArcadeCabinetId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRooms_Code_Status",
                table: "GamePlayRooms",
                columns: new[] { "Code", "Status" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRooms_CreatedByProfileId",
                table: "GamePlayRooms",
                column: "CreatedByProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRooms_GameFileId",
                table: "GamePlayRooms",
                column: "GameFileId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRooms_GameId_GameFileId_Status",
                table: "GamePlayRooms",
                columns: new[] { "GameId", "GameFileId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_GamePlayRooms_NosebleedSessionId",
                table: "GamePlayRooms",
                column: "NosebleedSessionId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_ExternalSessionId",
                table: "GamePlaySessions",
                column: "ExternalSessionId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_GameFileId",
                table: "GamePlaySessions",
                column: "GameFileId");

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_GameId_StartedUtc",
                table: "GamePlaySessions",
                columns: new[] { "GameId", "StartedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_Mode_StartedUtc",
                table: "GamePlaySessions",
                columns: new[] { "Mode", "StartedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_ProfileId_StartedUtc",
                table: "GamePlaySessions",
                columns: new[] { "ProfileId", "StartedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_Games_Crc32",
                table: "Games",
                column: "Crc32");

            migrationBuilder.CreateIndex(
                name: "IX_Games_CreatedUtc",
                table: "Games",
                column: "CreatedUtc");

            migrationBuilder.CreateIndex(
                name: "IX_Games_Name",
                table: "Games",
                column: "Name");

            migrationBuilder.CreateIndex(
                name: "IX_Games_SystemName",
                table: "Games",
                column: "SystemName");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileAuthSessions_ProfileId",
                table: "ProfileAuthSessions",
                column: "ProfileId",
                unique: true,
                filter: "\"RevokedUtc\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileAuthSessions_ProfileId_RevokedUtc",
                table: "ProfileAuthSessions",
                columns: new[] { "ProfileId", "RevokedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileAuthSessions_SessionNonce",
                table: "ProfileAuthSessions",
                column: "SessionNonce",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileCorePreferences_ProfileId_SystemName",
                table: "ProfileCorePreferences",
                columns: new[] { "ProfileId", "SystemName" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaveRevisions_GamePlaySessionId",
                table: "ProfileGameSaveRevisions",
                column: "GamePlaySessionId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaveRevisions_ProfileGameSaveId_RevisionTimestam~",
                table: "ProfileGameSaveRevisions",
                columns: new[] { "ProfileGameSaveId", "RevisionTimestampUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaves_GameFileId",
                table: "ProfileGameSaves",
                column: "GameFileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaves_GameId",
                table: "ProfileGameSaves",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaves_LatestRevisionId",
                table: "ProfileGameSaves",
                column: "LatestRevisionId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaves_ProfileId_GameId_GameFileId_Kind_Key_FileN~",
                table: "ProfileGameSaves",
                columns: new[] { "ProfileId", "GameId", "GameFileId", "Kind", "Key", "FileName", "CoreKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaves_ProfileId_UpdatedUtc",
                table: "ProfileGameSaves",
                columns: new[] { "ProfileId", "UpdatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileInviteCodes_Code",
                table: "ProfileInviteCodes",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileInviteCodes_UsedByProfileId",
                table: "ProfileInviteCodes",
                column: "UsedByProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfilePinnedGames_GameId",
                table: "ProfilePinnedGames",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfilePinnedGames_ProfileId_GameId",
                table: "ProfilePinnedGames",
                columns: new[] { "ProfileId", "GameId" },
                unique: true,
                filter: "NOT \"IsArchived\"");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_CreatedByProfileId",
                table: "ProfileShareLinks",
                column: "CreatedByProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_GameId",
                table: "ProfileShareLinks",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_ParentProfileId_CreatedUtc",
                table: "ProfileShareLinks",
                columns: new[] { "ParentProfileId", "CreatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_RedeemedByProfileId",
                table: "ProfileShareLinks",
                column: "RedeemedByProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_RoomId_CreatedUtc",
                table: "ProfileShareLinks",
                columns: new[] { "RoomId", "CreatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_TokenHash",
                table: "ProfileShareLinks",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareRedeemSessions_ProfileShareLinkId",
                table: "ProfileShareRedeemSessions",
                column: "ProfileShareLinkId");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfilePasskeys_CredentialIdBase64Url",
                table: "UserProfilePasskeys",
                column: "CredentialIdBase64Url",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UserProfilePasskeys_ProfileId",
                table: "UserProfilePasskeys",
                column: "ProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfilePasskeys_UserHandleBase64Url",
                table: "UserProfilePasskeys",
                column: "UserHandleBase64Url");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_CreatedFromShareLinkId",
                table: "UserProfiles",
                column: "CreatedFromShareLinkId");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_DisplayName",
                table: "UserProfiles",
                column: "DisplayName");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_ParentProfileId",
                table: "UserProfiles",
                column: "ParentProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_PasskeyUserHandleBase64Url",
                table: "UserProfiles",
                column: "PasskeyUserHandleBase64Url",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_Username",
                table: "UserProfiles",
                column: "Username",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRoomChatMessages_GamePlayRooms_RoomId",
                table: "GamePlayRoomChatMessages",
                column: "RoomId",
                principalTable: "GamePlayRooms",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRoomChatMessages_UserProfiles_ProfileId",
                table: "GamePlayRoomChatMessages",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRoomParticipants_GamePlayRooms_RoomId",
                table: "GamePlayRoomParticipants",
                column: "RoomId",
                principalTable: "GamePlayRooms",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRoomParticipants_UserProfiles_ProfileId",
                table: "GamePlayRoomParticipants",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRooms_UserProfiles_CreatedByProfileId",
                table: "GamePlayRooms",
                column: "CreatedByProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlaySessions_UserProfiles_ProfileId",
                table: "GamePlaySessions",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileAuthSessions_UserProfiles_ProfileId",
                table: "ProfileAuthSessions",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileCorePreferences_UserProfiles_ProfileId",
                table: "ProfileCorePreferences",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaveRevisions_ProfileGameSaves_ProfileGameSaveId",
                table: "ProfileGameSaveRevisions",
                column: "ProfileGameSaveId",
                principalTable: "ProfileGameSaves",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                table: "ProfileGameSaves",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileInviteCodes_UserProfiles_UsedByProfileId",
                table: "ProfileInviteCodes",
                column: "UsedByProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfilePinnedGames_UserProfiles_ProfileId",
                table: "ProfilePinnedGames",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileShareLinks_UserProfiles_CreatedByProfileId",
                table: "ProfileShareLinks",
                column: "CreatedByProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileShareLinks_UserProfiles_ParentProfileId",
                table: "ProfileShareLinks",
                column: "ParentProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileShareLinks_UserProfiles_RedeemedByProfileId",
                table: "ProfileShareLinks",
                column: "RedeemedByProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ArcadeCabinets_Arcades_ArcadeId",
                table: "ArcadeCabinets");

            migrationBuilder.DropForeignKey(
                name: "FK_ArcadeCabinets_GameFiles_GameFileId",
                table: "ArcadeCabinets");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlayRooms_GameFiles_GameFileId",
                table: "GamePlayRooms");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlaySessions_GameFiles_GameFileId",
                table: "GamePlaySessions");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ArcadeCabinets_Games_GameId",
                table: "ArcadeCabinets");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlayRooms_Games_GameId",
                table: "GamePlayRooms");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlaySessions_Games_GameId",
                table: "GamePlaySessions");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_Games_GameId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileShareLinks_Games_GameId",
                table: "ProfileShareLinks");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileShareLinks_GamePlayRooms_RoomId",
                table: "ProfileShareLinks");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlaySessions_UserProfiles_ProfileId",
                table: "GamePlaySessions");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileShareLinks_UserProfiles_CreatedByProfileId",
                table: "ProfileShareLinks");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileShareLinks_UserProfiles_ParentProfileId",
                table: "ProfileShareLinks");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileShareLinks_UserProfiles_RedeemedByProfileId",
                table: "ProfileShareLinks");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaveRevisions_GamePlaySessions_GamePlaySessionId",
                table: "ProfileGameSaveRevisions");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaveRevisions_ProfileGameSaves_ProfileGameSaveId",
                table: "ProfileGameSaveRevisions");

            migrationBuilder.DropTable(
                name: "Artifacts");

            migrationBuilder.DropTable(
                name: "GameBatchItems");

            migrationBuilder.DropTable(
                name: "GamePlayerFiles");

            migrationBuilder.DropTable(
                name: "GamePlayRoomChatMessages");

            migrationBuilder.DropTable(
                name: "GamePlayRoomParticipants");

            migrationBuilder.DropTable(
                name: "LocalFolders");

            migrationBuilder.DropTable(
                name: "LocalScanResults");

            migrationBuilder.DropTable(
                name: "NetworkScanResults");

            migrationBuilder.DropTable(
                name: "NetworkShares");

            migrationBuilder.DropTable(
                name: "ProfileAuthSessions");

            migrationBuilder.DropTable(
                name: "ProfileCorePreferences");

            migrationBuilder.DropTable(
                name: "ProfileInviteCodes");

            migrationBuilder.DropTable(
                name: "ProfilePinnedGames");

            migrationBuilder.DropTable(
                name: "ProfileShareRedeemSessions");

            migrationBuilder.DropTable(
                name: "SystemFiles");

            migrationBuilder.DropTable(
                name: "UserProfilePasskeys");

            migrationBuilder.DropTable(
                name: "WebScanResults");

            migrationBuilder.DropTable(
                name: "WebSources");

            migrationBuilder.DropTable(
                name: "GameBatches");

            migrationBuilder.DropTable(
                name: "Arcades");

            migrationBuilder.DropTable(
                name: "GameFiles");

            migrationBuilder.DropTable(
                name: "Games");

            migrationBuilder.DropTable(
                name: "GamePlayRooms");

            migrationBuilder.DropTable(
                name: "ArcadeCabinets");

            migrationBuilder.DropTable(
                name: "UserProfiles");

            migrationBuilder.DropTable(
                name: "ProfileShareLinks");

            migrationBuilder.DropTable(
                name: "GamePlaySessions");

            migrationBuilder.DropTable(
                name: "ProfileGameSaves");

            migrationBuilder.DropTable(
                name: "ProfileGameSaveRevisions");
        }
    }
}
