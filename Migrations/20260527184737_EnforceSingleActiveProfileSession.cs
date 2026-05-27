using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class EnforceSingleActiveProfileSession : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_ProfileAuthSessions_ProfileId",
                table: "ProfileAuthSessions",
                column: "ProfileId",
                unique: true,
                filter: "\"RevokedUtc\" IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ProfileAuthSessions_ProfileId",
                table: "ProfileAuthSessions");
        }
    }
}
