using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddRoomSessionManagement : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GamePlayRooms",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Code = table.Column<string>(type: "TEXT", maxLength: 4, nullable: false),
                    GameId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameFileId = table.Column<int>(type: "INTEGER", nullable: false),
                    NosebleedSessionId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    CreatedByProfileId = table.Column<int>(type: "INTEGER", nullable: true),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastActiveUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ClosedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    IsArcadeBound = table.Column<bool>(type: "INTEGER", nullable: false),
                    ArcadeCabinetId = table.Column<int>(type: "INTEGER", nullable: true)
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
                    table.ForeignKey(
                        name: "FK_GamePlayRooms_UserProfiles_CreatedByProfileId",
                        column: x => x.CreatedByProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "ProfileAuthSessions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ProfileId = table.Column<int>(type: "INTEGER", nullable: false),
                    SessionNonce = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserAgentHash = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    LastSeenUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    RevokedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileAuthSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileAuthSessions_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GamePlayRoomChatMessages",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    RoomId = table.Column<int>(type: "INTEGER", nullable: false),
                    ProfileId = table.Column<int>(type: "INTEGER", nullable: true),
                    DisplayNameSnapshot = table.Column<string>(type: "TEXT", maxLength: 80, nullable: true),
                    Message = table.Column<string>(type: "TEXT", maxLength: 280, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlayRoomChatMessages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GamePlayRoomChatMessages_GamePlayRooms_RoomId",
                        column: x => x.RoomId,
                        principalTable: "GamePlayRooms",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_GamePlayRoomChatMessages_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "GamePlayRoomParticipants",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    RoomId = table.Column<int>(type: "INTEGER", nullable: false),
                    ViewerId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    ProfileId = table.Column<int>(type: "INTEGER", nullable: true),
                    DisplayNameSnapshot = table.Column<string>(type: "TEXT", maxLength: 80, nullable: true),
                    Role = table.Column<int>(type: "INTEGER", nullable: false),
                    Port = table.Column<int>(type: "INTEGER", nullable: true),
                    JoinedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastSeenUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    IsConnected = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GamePlayRoomParticipants", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GamePlayRoomParticipants_GamePlayRooms_RoomId",
                        column: x => x.RoomId,
                        principalTable: "GamePlayRooms",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_GamePlayRoomParticipants_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

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
                name: "IX_ProfileAuthSessions_ProfileId_RevokedUtc",
                table: "ProfileAuthSessions",
                columns: new[] { "ProfileId", "RevokedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileAuthSessions_SessionNonce",
                table: "ProfileAuthSessions",
                column: "SessionNonce",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GamePlayRoomChatMessages");

            migrationBuilder.DropTable(
                name: "GamePlayRoomParticipants");

            migrationBuilder.DropTable(
                name: "ProfileAuthSessions");

            migrationBuilder.DropTable(
                name: "GamePlayRooms");
        }
    }
}
