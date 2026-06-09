using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class AddFailedLoginTracking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "FailedLoginAttempts",
                table: "UserProfiles",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTime>(
                name: "LoginLockoutUntilUtc",
                table: "UserProfiles",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FailedLoginAttempts",
                table: "UserProfiles");

            migrationBuilder.DropColumn(
                name: "LoginLockoutUntilUtc",
                table: "UserProfiles");
        }
    }
}
