using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class Batch4ModelChanges : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ProfileAuthSessions_UserProfiles_ProfileId",
                table: "ProfileAuthSessions");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_Games_GameId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                table: "ProfileGameSaves");

            migrationBuilder.AddColumn<byte[]>(
                name: "ConcurrencyToken",
                table: "BackgroundJobs",
                type: "BLOB",
                rowVersion: true,
                nullable: true);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileAuthSessions_UserProfiles_ProfileId",
                table: "ProfileAuthSessions",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                table: "ProfileGameSaves",
                column: "GameFileId",
                principalTable: "GameFiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_Games_GameId",
                table: "ProfileGameSaves",
                column: "GameId",
                principalTable: "Games",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                table: "ProfileGameSaves",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_ProfileAuthSessions_UserProfiles_ProfileId",
                table: "ProfileAuthSessions");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_Games_GameId",
                table: "ProfileGameSaves");

            migrationBuilder.DropForeignKey(
                name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                table: "ProfileGameSaves");

            migrationBuilder.DropColumn(
                name: "ConcurrencyToken",
                table: "BackgroundJobs");

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileAuthSessions_UserProfiles_ProfileId",
                table: "ProfileAuthSessions",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_GameFiles_GameFileId",
                table: "ProfileGameSaves",
                column: "GameFileId",
                principalTable: "GameFiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_Games_GameId",
                table: "ProfileGameSaves",
                column: "GameId",
                principalTable: "Games",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_ProfileGameSaves_UserProfiles_ProfileId",
                table: "ProfileGameSaves",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
