using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddUserProfilesAndProfileTelemetry : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ProfileId",
                table: "GamePlaySessions",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "UserProfiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    DisplayName = table.Column<string>(type: "TEXT", maxLength: 80, nullable: false),
                    AvatarKey = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    Color = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    PasskeyUserHandleBase64Url = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    IsArchived = table.Column<bool>(type: "INTEGER", nullable: false),
                    IsAdmin = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserProfiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "UserProfilePasskeys",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ProfileId = table.Column<int>(type: "INTEGER", nullable: false),
                    CredentialIdBase64Url = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                    PublicKey = table.Column<byte[]>(type: "BLOB", nullable: false),
                    UserHandleBase64Url = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    SignatureCounter = table.Column<uint>(type: "INTEGER", nullable: false),
                    DeviceName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserProfilePasskeys", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UserProfilePasskeys_UserProfiles_ProfileId",
                        column: x => x.ProfileId,
                        principalTable: "UserProfiles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_GamePlaySessions_ProfileId_StartedUtc",
                table: "GamePlaySessions",
                columns: new[] { "ProfileId", "StartedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_UserProfilePasskeys_CredentialIdBase64Url",
                table: "UserProfilePasskeys",
                column: "CredentialIdBase64Url",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UserProfilePasskeys_ProfileId",
                table: "UserProfilePasskeys",
                column: "ProfileId");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfilePasskeys_UserHandleBase64Url",
                table: "UserProfilePasskeys",
                column: "UserHandleBase64Url");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_DisplayName",
                table: "UserProfiles",
                column: "DisplayName");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_PasskeyUserHandleBase64Url",
                table: "UserProfiles",
                column: "PasskeyUserHandleBase64Url",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_GamePlaySessions_UserProfiles_ProfileId",
                table: "GamePlaySessions",
                column: "ProfileId",
                principalTable: "UserProfiles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_GamePlaySessions_UserProfiles_ProfileId",
                table: "GamePlaySessions");

            migrationBuilder.DropTable(
                name: "UserProfilePasskeys");

            migrationBuilder.DropTable(
                name: "UserProfiles");

            migrationBuilder.DropIndex(
                name: "IX_GamePlaySessions_ProfileId_StartedUtc",
                table: "GamePlaySessions");

            migrationBuilder.DropColumn(
                name: "ProfileId",
                table: "GamePlaySessions");
        }
    }
}
