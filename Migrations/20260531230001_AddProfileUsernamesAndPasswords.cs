using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileUsernamesAndPasswords : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "PinHash",
                table: "UserProfiles",
                newName: "PasswordHash");

            migrationBuilder.AddColumn<string>(
                name: "Username",
                table: "UserProfiles",
                type: "TEXT",
                maxLength: 32,
                nullable: true);

            migrationBuilder.Sql("UPDATE \"UserProfiles\" SET \"Username\" = 'player-' || \"Id\" WHERE \"Username\" IS NULL OR trim(\"Username\") = '';");

            migrationBuilder.CreateIndex(
                name: "IX_UserProfiles_Username",
                table: "UserProfiles",
                column: "Username",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_UserProfiles_Username",
                table: "UserProfiles");

            migrationBuilder.DropColumn(
                name: "Username",
                table: "UserProfiles");

            migrationBuilder.RenameColumn(
                name: "PasswordHash",
                table: "UserProfiles",
                newName: "PinHash");
        }
    }
}
