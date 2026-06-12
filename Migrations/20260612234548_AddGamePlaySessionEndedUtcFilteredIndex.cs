using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddGamePlaySessionEndedUtcFilteredIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ArcadeCabinets_Games_GameId",
                table: "ArcadeCabinets");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlayRooms_Games_GameId",
                table: "GamePlayRooms");

            migrationBuilder.AddColumn<byte[]>(
                name: "ConcurrencyToken",
                table: "GamePlayRooms",
                type: "bytea",
                rowVersion: true,
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "ConcurrencyToken",
                table: "ArcadeCabinets",
                type: "bytea",
                rowVersion: true,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_EndedUtc",
                table: "GamePlaySessions",
                column: "EndedUtc",
                filter: "\"EndedUtc\" IS NULL");

            migrationBuilder.AddForeignKey(
                name: "FK_ArcadeCabinets_Games_GameId",
                table: "ArcadeCabinets",
                column: "GameId",
                principalTable: "Games",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRooms_Games_GameId",
                table: "GamePlayRooms",
                column: "GameId",
                principalTable: "Games",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ArcadeCabinets_Games_GameId",
                table: "ArcadeCabinets");

            migrationBuilder.DropForeignKey(
                name: "FK_GamePlayRooms_Games_GameId",
                table: "GamePlayRooms");

            migrationBuilder.DropIndex(
                name: "IX_GamePlaySessions_EndedUtc",
                table: "GamePlaySessions");

            migrationBuilder.DropColumn(
                name: "ConcurrencyToken",
                table: "GamePlayRooms");

            migrationBuilder.DropColumn(
                name: "ConcurrencyToken",
                table: "ArcadeCabinets");

            migrationBuilder.AddForeignKey(
                name: "FK_ArcadeCabinets_Games_GameId",
                table: "ArcadeCabinets",
                column: "GameId",
                principalTable: "Games",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlayRooms_Games_GameId",
                table: "GamePlayRooms",
                column: "GameId",
                principalTable: "Games",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
