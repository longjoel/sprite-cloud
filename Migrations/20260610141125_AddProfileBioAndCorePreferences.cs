using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileBioAndCorePreferences : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Bio",
                table: "UserProfiles",
                type: "TEXT",
                maxLength: 500,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "ProfileCorePreferences",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ProfileId = table.Column<int>(type: "INTEGER", nullable: false),
                    SystemName = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    CorePath = table.Column<string>(type: "TEXT", maxLength: 260, nullable: true),
                    CoreKey = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileCorePreferences", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileCorePreferences_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileCorePreferences_ProfileId_SystemName",
                table: "ProfileCorePreferences",
                columns: new[] { "ProfileId", "SystemName" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ProfileCorePreferences");

            migrationBuilder.DropColumn(
                name: "Bio",
                table: "UserProfiles");
        }
    }
}
