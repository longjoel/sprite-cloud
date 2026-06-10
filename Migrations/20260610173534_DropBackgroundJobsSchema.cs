using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace games_vault.Migrations
{
    /// <inheritdoc />
    public partial class DropBackgroundJobsSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_LocalScanResults_LocalScanRuns_LocalScanRunId",
                table: "LocalScanResults");

            migrationBuilder.DropForeignKey(
                name: "FK_NetworkScanResults_NetworkScanRuns_NetworkScanRunId",
                table: "NetworkScanResults");

            migrationBuilder.DropForeignKey(
                name: "FK_WebScanResults_WebScanRuns_WebScanRunId",
                table: "WebScanResults");

            migrationBuilder.DropTable(
                name: "BackgroundJobLogEntries");

            migrationBuilder.DropTable(
                name: "LocalScanRuns");

            migrationBuilder.DropTable(
                name: "NetworkScanRuns");

            migrationBuilder.DropTable(
                name: "WebScanRuns");

            migrationBuilder.DropTable(
                name: "BackgroundJobs");

            migrationBuilder.DropIndex(
                name: "IX_WebScanResults_WebScanRunId",
                table: "WebScanResults");

            migrationBuilder.DropIndex(
                name: "IX_NetworkScanResults_NetworkScanRunId",
                table: "NetworkScanResults");

            migrationBuilder.DropIndex(
                name: "IX_LocalScanResults_LocalScanRunId",
                table: "LocalScanResults");

            migrationBuilder.DropColumn(
                name: "WebScanRunId",
                table: "WebScanResults");

            migrationBuilder.DropColumn(
                name: "NetworkScanRunId",
                table: "NetworkScanResults");

            migrationBuilder.DropColumn(
                name: "LocalScanRunId",
                table: "LocalScanResults");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "WebScanRunId",
                table: "WebScanResults",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "NetworkScanRunId",
                table: "NetworkScanResults",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "LocalScanRunId",
                table: "LocalScanResults",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "BackgroundJobs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Attempt = table.Column<int>(type: "INTEGER", nullable: false),
                    Command = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    CompletedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    ConcurrencyToken = table.Column<byte[]>(type: "BLOB", rowVersion: true, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastError = table.Column<string>(type: "TEXT", nullable: true),
                    LockedBy = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    LockedUntilUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    MaxAttempts = table.Column<int>(type: "INTEGER", nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: false),
                    ProgressPermille = table.Column<int>(type: "INTEGER", nullable: true),
                    StartedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackgroundJobs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BackgroundJobLogEntries",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    BackgroundJobId = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    Level = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    Message = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackgroundJobLogEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_BackgroundJobLogEntries_BackgroundJobs_BackgroundJobId",
                        column: x => x.BackgroundJobId,
                        principalTable: "BackgroundJobs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "LocalScanRuns",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    BackgroundJobId = table.Column<int>(type: "INTEGER", nullable: false),
                    LocalFolderId = table.Column<int>(type: "INTEGER", nullable: false),
                    CompletedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    FileCount = table.Column<int>(type: "INTEGER", nullable: false),
                    SessionId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LocalScanRuns", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LocalScanRuns_BackgroundJobs_BackgroundJobId",
                        column: x => x.BackgroundJobId,
                        principalTable: "BackgroundJobs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_LocalScanRuns_LocalFolders_LocalFolderId",
                        column: x => x.LocalFolderId,
                        principalTable: "LocalFolders",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "NetworkScanRuns",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    BackgroundJobId = table.Column<int>(type: "INTEGER", nullable: false),
                    NetworkShareId = table.Column<int>(type: "INTEGER", nullable: false),
                    CompletedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    FileCount = table.Column<int>(type: "INTEGER", nullable: false),
                    SessionId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NetworkScanRuns", x => x.Id);
                    table.ForeignKey(
                        name: "FK_NetworkScanRuns_BackgroundJobs_BackgroundJobId",
                        column: x => x.BackgroundJobId,
                        principalTable: "BackgroundJobs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_NetworkScanRuns_NetworkShares_NetworkShareId",
                        column: x => x.NetworkShareId,
                        principalTable: "NetworkShares",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "WebScanRuns",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    BackgroundJobId = table.Column<int>(type: "INTEGER", nullable: false),
                    WebSourceId = table.Column<int>(type: "INTEGER", nullable: false),
                    CompletedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LinkCount = table.Column<int>(type: "INTEGER", nullable: false),
                    SessionId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WebScanRuns", x => x.Id);
                    table.ForeignKey(
                        name: "FK_WebScanRuns_BackgroundJobs_BackgroundJobId",
                        column: x => x.BackgroundJobId,
                        principalTable: "BackgroundJobs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_WebScanRuns_WebSources_WebSourceId",
                        column: x => x.WebSourceId,
                        principalTable: "WebSources",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_WebScanResults_WebScanRunId",
                table: "WebScanResults",
                column: "WebScanRunId");

            migrationBuilder.CreateIndex(
                name: "IX_NetworkScanResults_NetworkScanRunId",
                table: "NetworkScanResults",
                column: "NetworkScanRunId");

            migrationBuilder.CreateIndex(
                name: "IX_LocalScanResults_LocalScanRunId",
                table: "LocalScanResults",
                column: "LocalScanRunId");

            migrationBuilder.CreateIndex(
                name: "IX_BackgroundJobLogEntries_BackgroundJobId",
                table: "BackgroundJobLogEntries",
                column: "BackgroundJobId");

            migrationBuilder.CreateIndex(
                name: "IX_BackgroundJobs_Status",
                table: "BackgroundJobs",
                column: "Status");

            migrationBuilder.CreateIndex(
                name: "IX_LocalScanRuns_BackgroundJobId",
                table: "LocalScanRuns",
                column: "BackgroundJobId");

            migrationBuilder.CreateIndex(
                name: "IX_LocalScanRuns_LocalFolderId",
                table: "LocalScanRuns",
                column: "LocalFolderId");

            migrationBuilder.CreateIndex(
                name: "IX_NetworkScanRuns_BackgroundJobId",
                table: "NetworkScanRuns",
                column: "BackgroundJobId");

            migrationBuilder.CreateIndex(
                name: "IX_NetworkScanRuns_NetworkShareId",
                table: "NetworkScanRuns",
                column: "NetworkShareId");

            migrationBuilder.CreateIndex(
                name: "IX_WebScanRuns_BackgroundJobId",
                table: "WebScanRuns",
                column: "BackgroundJobId");

            migrationBuilder.CreateIndex(
                name: "IX_WebScanRuns_WebSourceId",
                table: "WebScanRuns",
                column: "WebSourceId");

            migrationBuilder.AddForeignKey(
                name: "FK_LocalScanResults_LocalScanRuns_LocalScanRunId",
                table: "LocalScanResults",
                column: "LocalScanRunId",
                principalTable: "LocalScanRuns",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_NetworkScanResults_NetworkScanRuns_NetworkScanRunId",
                table: "NetworkScanResults",
                column: "NetworkScanRunId",
                principalTable: "NetworkScanRuns",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_WebScanResults_WebScanRuns_WebScanRunId",
                table: "WebScanResults",
                column: "WebScanRunId",
                principalTable: "WebScanRuns",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
