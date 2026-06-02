using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileShareLinksAndGuestProfiles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CreatedFromShareLinkId",
                table: "UserProfiles",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsEphemeral",
                table: "UserProfiles",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "ParentProfileId",
                table: "UserProfiles",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "ProfileShareLinks",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    TokenHash = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    RoomId = table.Column<int>(type: "INTEGER", nullable: false),
                    GameId = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedByProfileId = table.Column<int>(type: "INTEGER", nullable: false),
                    ParentProfileId = table.Column<int>(type: "INTEGER", nullable: false),
                    GrantMode = table.Column<int>(type: "INTEGER", nullable: false),
                    MaxUses = table.Column<int>(type: "INTEGER", nullable: false),
                    UseCount = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ExpiresUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    RevokedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    RedeemedByProfileId = table.Column<int>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProfileShareLinks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_GamePlayRooms_RoomId",
                        column: x => x.RoomId,
                        principalTable: "GamePlayRooms",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_UserProfiles_CreatedByProfileId",
                        column: x => x.CreatedByProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_UserProfiles_ParentProfileId",
                        column: x => x.ParentProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ProfileShareLinks_UserProfiles_RedeemedByProfileId",
                        column: x => x.RedeemedByProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_CreatedFromShareLinkId",
                table: "UserProfiles",
                column: "CreatedFromShareLinkId");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_ParentProfileId",
                table: "UserProfiles",
                column: "ParentProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_CreatedByProfileId",
                table: "ProfileShareLinks",
                column: "CreatedByProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_GameId",
                table: "ProfileShareLinks",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_ParentProfileId_CreatedUtc",
                table: "ProfileShareLinks",
                columns: new[] { "ParentProfileId", "CreatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_RedeemedByProfileId",
                table: "ProfileShareLinks",
                column: "RedeemedByProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_RoomId_CreatedUtc",
                table: "ProfileShareLinks",
                columns: new[] { "RoomId", "CreatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ProfileShareLinks_TokenHash",
                table: "ProfileShareLinks",
                column: "TokenHash",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_UserProfiles_ProfileShareLinks_CreatedFromShareLinkId",
                table: "UserProfiles",
                column: "CreatedFromShareLinkId",
                principalTable: "ProfileShareLinks",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_UserProfiles_UserProfiles_ParentProfileId",
                table: "UserProfiles",
                column: "ParentProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_UserProfiles_ProfileShareLinks_CreatedFromShareLinkId",
                table: "UserProfiles");

            migrationBuilder.DropForeignKey(
                name: "FK_UserProfiles_UserProfiles_ParentProfileId",
                table: "UserProfiles");

            migrationBuilder.DropTable(
                name: "ProfileShareLinks");

            migrationBuilder.DropIndex(
                name: "IX_UserProfiles_CreatedFromShareLinkId",
                table: "UserProfiles");

            migrationBuilder.DropIndex(
                name: "IX_UserProfiles_ParentProfileId",
                table: "UserProfiles");

            migrationBuilder.DropColumn(
                name: "CreatedFromShareLinkId",
                table: "UserProfiles");

            migrationBuilder.DropColumn(
                name: "IsEphemeral",
                table: "UserProfiles");

            migrationBuilder.DropColumn(
                name: "ParentProfileId",
                table: "UserProfiles");
        }
    }
}
