using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileShareRedeemSession : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ProfileShareRedeemSessions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ProfileShareLinkId = table.Column<int>(type: "INTEGER", nullable: false),
                    SessionCode = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ExpiresUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ConsumedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileShareRedeemSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileShareRedeemSessions_ProfileShareLinks_ProfileShareLinkId",
                        column: x => x.ProfileShareLinkId,
                        principalTable: "ProfileShareLinks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareRedeemSessions_ProfileShareLinkId",
                table: "ProfileShareRedeemSessions",
                column: "ProfileShareLinkId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ProfileShareRedeemSessions");
        }
    }
}
