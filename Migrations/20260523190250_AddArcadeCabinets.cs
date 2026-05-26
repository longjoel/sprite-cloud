using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddArcadeCabinets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Arcades",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Name = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    Slug = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    Description = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    IsEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Arcades", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ArcadeCabinets",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ArcadeId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameFileId = table.Column<int>(type: "INTEGER", nullable: true),
                    DisplayName = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    SortOrder = table.Column<int>(type: "INTEGER", nullable: false),
                    IsEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    AutoRestart = table.Column<bool>(type: "INTEGER", nullable: false),
                    CreditMode = table.Column<int>(type: "INTEGER", nullable: false),
                    TokenCostPerCredit = table.Column<int>(type: "INTEGER", nullable: false),
                    RuntimeSessionId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    LastStartedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                    LastSeenAliveUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                    LastError = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
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
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ArcadeCabinets");

            migrationBuilder.DropTable(
                name: "Arcades");
        }
    }
}
