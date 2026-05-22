using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddSystemCoreMappings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SystemCoreMappings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    SystemName = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    NativeCoreFileName = table.Column<string>(type: "TEXT", maxLength: 260, nullable: true),
                    WebPlayerCoreKey = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    IsEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    Notes = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SystemCoreMappings", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SystemCoreMappings_SystemName",
                table: "SystemCoreMappings",
                column: "SystemName",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SystemCoreMappings");
        }
    }
}
