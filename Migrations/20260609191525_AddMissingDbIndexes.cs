using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddMissingDbIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
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
                name: "IX_GameFiles_Crc32",
                table: "GameFiles",
                column: "Crc32");

            migrationBuilder.CreateIndex(
                name: "IX_BackgroundJobs_Status",
                table: "BackgroundJobs",
                column: "Status");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Games_Crc32",
                table: "Games");

            migrationBuilder.DropIndex(
                name: "IX_Games_CreatedUtc",
                table: "Games");

            migrationBuilder.DropIndex(
                name: "IX_Games_Name",
                table: "Games");

            migrationBuilder.DropIndex(
                name: "IX_Games_SystemName",
                table: "Games");

            migrationBuilder.DropIndex(
                name: "IX_GameFiles_Crc32",
                table: "GameFiles");

            migrationBuilder.DropIndex(
                name: "IX_BackgroundJobs_Status",
                table: "BackgroundJobs");
        }
    }
}
