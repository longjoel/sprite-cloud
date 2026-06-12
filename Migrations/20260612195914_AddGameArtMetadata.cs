using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddGameArtMetadata : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CoverImagePath",
                table: "Games",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GameArtError",
                table: "Games",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GameArtProvider",
                table: "Games",
                type: "character varying(80)",
                maxLength: 80,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GameArtStatus",
                table: "Games",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "LastGameArtLookupUtc",
                table: "Games",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ScreenshotImagePath",
                table: "Games",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CoverImagePath",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "GameArtError",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "GameArtProvider",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "GameArtStatus",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "LastGameArtLookupUtc",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "ScreenshotImagePath",
                table: "Games");
        }
    }
}
