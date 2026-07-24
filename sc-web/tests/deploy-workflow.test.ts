import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync("../.github/workflows/deploy.yml", "utf8");
const ciWorkflow = readFileSync("../.github/workflows/ci.yml", "utf8");
const releaseWorkflow = readFileSync("../.github/workflows/release.yml", "utf8");
const ciDockerfile = readFileSync("../docker/sc-web/Dockerfile.ci", "utf8");
const productionDockerfile = readFileSync("../docker/sc-web/Dockerfile.prod", "utf8");
const migrationHelper = readFileSync("../scripts/apply-sc-web-migration.sh", "utf8");
const scriptsReadme = readFileSync("../scripts/README.md", "utf8");
const releaseGuide = readFileSync("../docs/RELEASE.md", "utf8");
const hostInstaller = readFileSync("../scripts/install.sh", "utf8");
const publicInstaller = readFileSync("public/install.sh", "utf8");
const playerScript = readFileSync("public/player/play-v2.js", "utf8");
const scPlayerScript = readFileSync("public/player/sc-player.js", "utf8");
const browserLogger = readFileSync("public/browser-log.js", "utf8");
const productionEntrypoint = readFileSync("../docker/sc-web/entrypoint.prod.sh", "utf8");
const developmentEntrypoint = readFileSync("../docker/sc-web/entrypoint.sh", "utf8");
const migration = readFileSync("drizzle/0016_remove_cloud_library.sql", "utf8");
const publicWatch = readFileSync("lib/public-watch.ts", "utf8");
const watchPage = readFileSync("app/watch/page.tsx", "utf8");
const gamePlayer = readFileSync("components/GamePlayer.tsx", "utf8");
const commandRoute = readFileSync("app/api/server/command/route.ts", "utf8");
const playerServer = readFileSync("../sc-server/src/player_server.rs", "utf8");
const rootReadme = readFileSync("../README.md", "utf8");
const quickstart = readFileSync("../QUICKSTART.md", "utf8");

describe("production deploy workflow", () => {
  it("uses the installed nondefault VPS key for every SSH transport", () => {
    expect(workflow).toContain("name: vps-key");
    expect(workflow).not.toMatch(/\bssh -o StrictHostKeyChecking/);
    expect(workflow).not.toMatch(/\bscp -o StrictHostKeyChecking/);
    expect(workflow.match(/-i ~\/\.ssh\/vps-key/g)?.length).toBe(6);
  });

  it("treats a successful health curl exit code as success without capturing its body", () => {
    expect(workflow).toContain("if ssh -i ~/.ssh/vps-key -o StrictHostKeyChecking=accept-new");
    expect(workflow).toContain("docker compose exec -T web curl -fsS http://localhost:3000/api/health >/dev/null");
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
    const installIndex = hostInstaller.indexOf('install -m 0755');

    expect(checksum).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(checksum);
    expect(hostInstaller).not.toContain('curl -sSL "$BIN_URL" -o "$BIN_PATH"');
    expect(hostInstaller).not.toContain('ARCH="armv7"');
    expect(hostInstaller).toContain('mktemp "$BIN_DIR/.sc-server.XXXXXX"');
    expect(hostInstaller).toContain('mv -f "$STAGED_BIN" "$BIN_PATH"');
    expect(publicInstaller).toContain('mktemp "$INSTALL_DIR/.${BIN}.XXXXXX"');
    expect(publicInstaller).toContain('mv -f "$STAGED_BIN" "$INSTALL_DIR/$BIN"');
    expect(rootReadme).toContain("scripts/install.sh | bash -s --");
    expect(rootReadme).not.toContain("scripts/install.sh | sh -s --");
    expect(scriptsReadme).toContain("| bash -s --");
    expect(scriptsReadme).not.toContain("| sh -s --");
    expect(hostInstaller).not.toMatch(/\| sh(?:\s|$)/);
    expect(quickstart).toContain("sudo ./scripts/install.sh --web-url");
    expect(quickstart).not.toContain("https://sprite-cloud.com/install.sh");
    expect(quickstart).not.toContain("https://get.gamesvault.app");
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

  it("stages Next static assets inside the nonignored CI Docker context", () => {
    expect(ciWorkflow).toContain("cp -r sc-web/.next/static ./sc-web-standalone/.next/static");
    expect(ciDockerfile).toContain("COPY sc-web-standalone/.next/static/");
    expect(ciDockerfile).not.toContain("COPY sc-web/.next/static/");
  });

  it("isolates the production schema CLI from the application package graph", () => {
    expect(productionDockerfile).toContain("WORKDIR /app/schema-tools");
    expect(productionDockerfile).toContain("npm install drizzle-kit@0.31.10 postgres@3.4.9");
    expect(productionDockerfile).not.toContain("WORKDIR /app/sc-web\nRUN npm init");
    expect(productionEntrypoint).toContain("export NODE_PATH=/app/schema-tools/node_modules");
    expect(productionEntrypoint).toContain("/app/schema-tools/node_modules/.bin/drizzle-kit");
  });

  it("never pushes a destructive schema onto a nonempty database at startup", () => {
    for (const entrypoint of [productionEntrypoint, developmentEntrypoint]) {
      const nonemptyGuard = entrypoint.indexOf('if [ "$table_count" != "0" ]');
      const schemaPush = entrypoint.indexOf("drizzle-kit push --force");
      expect(entrypoint).toContain('GV_WEB_SCHEMA_PUSH_ON_START:-0');
      expect(nonemptyGuard).toBeGreaterThan(-1);
      expect(schemaPush).toBeGreaterThan(nonemptyGuard);
      expect(entrypoint).toContain("refusing schema push on a nonempty database");
    }
  });

  it("keeps the destructive migration atomic", () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*DROP TABLE IF EXISTS "server_rom_roots";[\s\S]*COMMIT;/);
  });

  it("keeps the permanent public watch URL free of room capabilities", () => {
    expect(publicWatch).not.toContain("`/r/${roomToken}");
    expect(publicWatch).toContain('like(sessions.roomToken, `${PUBLIC_ROOM_PREFIX}%`)');
    expect(publicWatch).not.toContain("ensureRoomToken");
    expect(watchPage).not.toContain("redirect(publicPath)");
    expect(watchPage).toContain("<PublicRoomPlayer {...publicSession} />");
  });

  it("requires an explicit user action before making a session public", () => {
    const gate = gamePlayer.indexOf("if (!shareRequested) return");
    const shareCall = gamePlayer.indexOf('fetch("/api/room/share"');
    expect(gamePlayer).toContain("setShareRequested(true)");
    expect(gate).toBeGreaterThan(-1);
    expect(shareCall).toBeGreaterThan(gate);
  });

  it("serializes fresh launches before replacing the current host session", () => {
    const lock = commandRoute.indexOf("pg_advisory_xact_lock");
    const victims = commandRoute.indexOf("const victims = await tx");
    const publish = commandRoute.indexOf("status: STATUS_PENDING", victims);
    expect(commandRoute).toContain("const prepared = await db.transaction");
    expect(commandRoute).toContain('const launchLockKey = `${serverId}:${uid}`');
    expect(commandRoute).toContain("eq(sessions.userId, uid)");
    expect(commandRoute).toContain("type: CMD_STOP_GAME");
    expect(commandRoute).toContain("session_id: victim.id");
    expect(commandRoute).toContain("roomToken: null");
    expect(commandRoute).not.toContain("recycledRoomToken");
    expect(commandRoute).not.toContain('const launchLockKey = `${serverId}:${hostToken');
    expect(lock).toBeGreaterThan(-1);
    expect(victims).toBeGreaterThan(lock);
    expect(publish).toBeGreaterThan(victims);
  });

  it("strips capability-bearing referrers and sends CSRF on UI stop", () => {
    expect(playerServer).toContain('name == "referer"');
    expect(gamePlayer).toMatch(/type: "stop_game",[\s\S]*?headers: csrfHeaders\(\)|headers: csrfHeaders\(\)[\s\S]*?type: "stop_game"/);
  });
});
