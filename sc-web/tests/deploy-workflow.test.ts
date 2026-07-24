import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync("../.github/workflows/deploy.yml", "utf8");
const releaseWorkflow = readFileSync("../.github/workflows/release.yml", "utf8");
const migrationHelper = readFileSync("../scripts/apply-sc-web-migration.sh", "utf8");
const scriptsReadme = readFileSync("../scripts/README.md", "utf8");
const releaseGuide = readFileSync("../docs/RELEASE.md", "utf8");
const hostInstaller = readFileSync("../scripts/install.sh", "utf8");
const playerScript = readFileSync("public/player/play-v2.js", "utf8");
const scPlayerScript = readFileSync("public/player/sc-player.js", "utf8");
const browserLogger = readFileSync("public/browser-log.js", "utf8");
const productionEntrypoint = readFileSync("../docker/sc-web/entrypoint.prod.sh", "utf8");
const migration = readFileSync("drizzle/0016_remove_cloud_library.sql", "utf8");
const publicWatch = readFileSync("lib/public-watch.ts", "utf8");
const watchPage = readFileSync("app/watch/page.tsx", "utf8");
const gamePlayer = readFileSync("components/GamePlayer.tsx", "utf8");
const playerServer = readFileSync("../sc-server/src/player_server.rs", "utf8");
const rootReadme = readFileSync("../README.md", "utf8");

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
    const backup = workflow.indexOf("Back up Postgres and apply Phase 4c migration");
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
    const nonempty = migrationHelper.indexOf("test -s");
    const apply = migrationHelper.indexOf("psql -U $PG_USER");
    const preHealth = migrationHelper.indexOf("HEALTH_JSON=");
    const readiness = migrationHelper.indexOf("phase4c_library_owner");
    const postHealth = migrationHelper.lastIndexOf("curl -fsS http://localhost:3000/api/health >/dev/null");

    expect(preHealth).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(preHealth);
    expect(backup).toBeGreaterThan(readiness);
    expect(backup).toBeGreaterThan(-1);
    expect(nonempty).toBeGreaterThan(backup);
    expect(apply).toBeGreaterThan(nonempty);
    expect(postHealth).toBeGreaterThan(apply);
    expect(migrationHelper).toContain("LEGACY_COUNT=");
    expect(migrationHelper).toContain('[[ "$LEGACY_COUNT" == "0" ]]');
    expect(migrationHelper).toContain("curl -fsS http://localhost:3000/api/health >/dev/null");
    expect(workflow).toContain("phase4c_library_owner");
    expect(scriptsReadme).toContain("creates and verifies a timestamped compressed database backup");
    expect(releaseGuide).toContain("verified backup third");
  });

  it("verifies the release checksum before replacing the installed host binary", () => {
    const checksum = hostInstaller.indexOf("sha256sum -c");
    const install = hostInstaller.indexOf('install -m 0755');

    expect(checksum).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(checksum);
    expect(hostInstaller).not.toContain('curl -sSL "$BIN_URL" -o "$BIN_PATH"');
    expect(hostInstaller).not.toContain('ARCH="armv7"');
    expect(rootReadme).toContain("scripts/install.sh | bash -s --");
    expect(rootReadme).not.toContain("scripts/install.sh | sh -s --");
  });

  it("publishes only after both advertised architecture builds succeed", () => {
    expect(releaseWorkflow).toContain("needs: [build-x86_64, build-aarch64]");
    expect(releaseWorkflow).not.toContain("continue-on-error: true");
    expect(releaseWorkflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(releaseWorkflow).toContain('test -f "artifacts/$arch/sc-server"');
  });

  it("never persists or logs raw browser signaling capabilities", () => {
    expect(playerScript).not.toContain('url.searchParams.set("host_token"');
    expect(playerScript).not.toContain('urlParams.get("host_token")');
    expect(playerScript).not.toContain("/api/server/notify?");
    expect(scPlayerScript).not.toContain("/api/server/notify?");
    expect(playerScript).toContain('fetch("/api/server/notify/poll"');
    expect(scPlayerScript).toContain('fetch("/api/server/notify/poll"');
    expect(playerScript).not.toContain('console.log("[gv] guest join — resolving room_token:", rt)');
    expect(playerScript).not.toContain('console.log("[gv] room/join response:", joinData)');
    expect(browserLogger).not.toContain("href: clampString(location.href");
    expect(browserLogger).not.toContain('roomToken: clampString(searchParams.get("join")');
    expect(browserLogger).toContain('out[key] = "[REDACTED]"');
    expect(browserLogger).toContain('location.pathname.replace(/^\\/r\\/[^/]+/, "/r/[redacted]")');
  });

  it("never pushes a destructive schema onto a nonempty database at startup", () => {
    const nonemptyGuard = productionEntrypoint.indexOf('if [ "$table_count" != "0" ]');
    const schemaPush = productionEntrypoint.indexOf("npx drizzle-kit push --force");
    expect(nonemptyGuard).toBeGreaterThan(-1);
    expect(schemaPush).toBeGreaterThan(nonemptyGuard);
    expect(productionEntrypoint).toContain("refusing schema push on a nonempty database");
  });

  it("keeps the destructive migration atomic", () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*DROP TABLE IF EXISTS "server_rom_roots";[\s\S]*COMMIT;/);
  });

  it("keeps the permanent public watch URL free of room capabilities", () => {
    expect(publicWatch).not.toContain("`/r/${roomToken}");
    expect(watchPage).not.toContain("redirect(publicPath)");
    expect(watchPage).toContain("<PublicRoomPlayer {...publicSession} />");
  });

  it("strips capability-bearing referrers and sends CSRF on UI stop", () => {
    expect(playerServer).toContain('name == "referer"');
    expect(gamePlayer).toMatch(/type: "stop_game",[\s\S]*?headers: csrfHeaders\(\)|headers: csrfHeaders\(\)[\s\S]*?type: "stop_game"/);
  });
});
