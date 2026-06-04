using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileBatterySaveHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ProfileGameSaveRevisions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ProfileGameSaveId = table.Column<int>(type: "INTEGER", nullable: false),
                    GamePlaySessionId = table.Column<int>(type: "INTEGER", nullable: true),
                    RevisionTimestampUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    StoragePath = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: false),
                    SizeBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    Sha256 = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    Source = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    OriginalUploadFileName = table.Column<string>(type: "TEXT", maxLength: 260, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false)
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
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ProfileId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameFileId = table.Column<int>(type: "INTEGER", nullable: false),
                    SystemName = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    CoreKey = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    Kind = table.Column<string>(type: "TEXT", maxLength: 50, nullable: false),
                    Key = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    FileName = table.Column<string>(type: "TEXT", maxLength: 260, nullable: false),
                    LatestRevisionId = table.Column<int>(type: "INTEGER", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileGameSaves", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                        column: x => x.GameFileId,
                        principalTable: "GameFiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_ProfileGameSaveRevisions_LatestRevisionId",
                        column: x => x.LatestRevisionId,
                        principalTable: "ProfileGameSaveRevisions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaveRevisions_GamePlaySessionId",
                table: "ProfileGameSaveRevisions",
                column: "GamePlaySessionId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaveRevisions_ProfileGameSaveId_RevisionTimestampUtc",
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
                name: "IX_ProfileGameSaves_ProfileId_GameId_GameFileId_Kind_Key_FileName_CoreKey",
                table: "ProfileGameSaves",
                columns: new[] { "ProfileId", "GameId", "GameFileId", "Kind", "Key", "FileName", "CoreKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileGameSaves_ProfileId_UpdatedUtc",
                table: "ProfileGameSaves",
                columns: new[] { "ProfileId", "UpdatedUtc" });

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaveRevisions_ProfileGameSaves_ProfileGameSaveId",
                table: "ProfileGameSaveRevisions",
                column: "ProfileGameSaveId",
                principalTable: "ProfileGameSaves",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaveRevisions_ProfileGameSaves_ProfileGameSaveId",
                table: "ProfileGameSaveRevisions");

            migrationBuilder.DropTable(
                name: "ProfileGameSaves");

            migrationBuilder.DropTable(
                name: "ProfileGameSaveRevisions");
        }
    }
}
