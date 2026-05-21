using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddGamePlaySessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GamePlaySessions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    GameId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameFileId = table.Column<int>(type: "INTEGER", nullable: true),
                    Mode = table.Column<string>(type: "TEXT", maxLength: 40, nullable: false),
                    ExternalSessionId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    StartedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    EndedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    DurationSeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    EndReason = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true)
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
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GamePlaySessions");
        }
    }
}
