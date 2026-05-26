using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileInvitesAndPins : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PinHash",
                table: "UserProfiles",
                type: "TEXT",
                maxLength: 256,
                nullable: true);

            migrationBuilder.Sql("UPDATE UserProfiles SET PinHash = 'pbkdf2-sha256$100000$Z2FtZXMtdmF1bHQtMDAwMA==$kUOw3H8stAGil7YWc+tGX31NGrlrWYgJnS5C+mNOhDI=' WHERE PinHash IS NULL OR PinHash = ''");

            migrationBuilder.CreateTable(
                name: "ProfileInviteCodes",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Code = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UsedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    UsedByProfileId = table.Column<int>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileInviteCodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileInviteCodes_UserProfiles_UsedByProfileId",
                        column: x => x.UsedByProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileInviteCodes_Code",
                table: "ProfileInviteCodes",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProfileInviteCodes_UsedByProfileId",
                table: "ProfileInviteCodes",
                column: "UsedByProfileId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ProfileInviteCodes");

            migrationBuilder.DropColumn(
                name: "PinHash",
                table: "UserProfiles");
        }
    }
}
