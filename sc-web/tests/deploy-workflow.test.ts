import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync("../.github/workflows/deploy.yml", "utf8");
const migrationHelper = readFileSync("../scripts/apply-sc-web-migration.sh", "utf8");
const scriptsReadme = readFileSync("../scripts/README.md", "utf8");
const releaseGuide = readFileSync("../docs/RELEASE.md", "utf8");

describe("production deploy workflow", () => {
  it("treats a successful health curl exit code as success without capturing its body", () => {
    expect(workflow).toContain("if ssh -o StrictHostKeyChecking=accept-new");
    expect(workflow).toContain("curl -fsS http://localhost:3000/api/health >/dev/null");
    expect(workflow).not.toContain("STATUS=$(ssh");
  });

  it("keeps the destructive migration explicitly disabled by default", () => {
    expect(workflow).toContain("apply_phase4c_migration:");
    expect(workflow).toMatch(/apply_phase4c_migration:[\s\S]*?default: false/);
    expect(workflow).toContain("inputs.apply_phase4c_migration");
  });

  it("deploys and health-checks before backup and migration", () => {
    const deploy = workflow.indexOf("Restart sc-web on VPS");
    const health = workflow.indexOf("- name: Health check");
    const backup = workflow.indexOf("Back up database and apply Phase 4c destructive migration");
    const pgDump = workflow.indexOf("pg_dump");
    const migration = workflow.indexOf("ON_ERROR_STOP=1");

    expect(deploy).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(deploy);
    expect(backup).toBeGreaterThan(health);
    expect(pgDump).toBeGreaterThan(backup);
    expect(migration).toBeGreaterThan(pgDump);
  });

  it("makes a verified backup mandatory in the canonical migration helper", () => {
    const backup = migrationHelper.indexOf("pg_dump");
    const nonempty = migrationHelper.indexOf("test -s '$BACKUP_FILE'");
    const apply = migrationHelper.indexOf('psql -U $PG_USER');

    expect(backup).toBeGreaterThan(-1);
    expect(nonempty).toBeGreaterThan(backup);
    expect(apply).toBeGreaterThan(nonempty);
    expect(scriptsReadme).toContain("creates and verifies a timestamped compressed database backup");
    expect(releaseGuide).toContain("verified backup third");
  });
});
