using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddGamePreviewImagePath : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PreviewImagePath",
                table: "Games",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PreviewImagePath",
                table: "Games");
        }
    }
}
