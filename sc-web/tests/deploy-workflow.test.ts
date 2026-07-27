import { existsSync, readFileSync } from "node:fs";
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
const serverSetup = readFileSync("../sc-server/src/setup.rs", "utf8");
const serverInstall = readFileSync("../sc-server/src/install.rs", "utf8");
const serverMain = readFileSync("../sc-server/src/main.rs", "utf8");
const serverUpgrade = readFileSync("../sc-server/src/upgrade.rs", "utf8");
const serverCommands = readFileSync("../sc-server/src/commands/mod.rs", "utf8");
const playerScript = readFileSync("public/player/play-v2.js", "utf8");
const scPlayerScript = readFileSync("public/player/sc-player.js", "utf8");
const browserLogger = readFileSync("public/browser-log.js", "utf8");
const productionEntrypoint = readFileSync("../docker/sc-web/entrypoint.prod.sh", "utf8");
const developmentEntrypoint = readFileSync("../docker/sc-web/entrypoint.sh", "utf8");
const hostEntrypoint = readFileSync("../docker/sc-server/entrypoint.sh", "utf8");
const migration = readFileSync("drizzle/0016_remove_cloud_library.sql", "utf8");
const gamePlayer = readFileSync("components/GamePlayer.tsx", "utf8");
const landingPage = readFileSync("components/LandingPage.tsx", "utf8");
const homePage = readFileSync("app/page.tsx", "utf8");
const shareRoute = readFileSync("app/api/room/share/route.ts", "utf8");
const nextConfig = readFileSync("next.config.ts", "utf8");
const deployScript = readFileSync("../scripts/deploy-sc-web.sh", "utf8");
const deployGuide = readFileSync("../docs/DEPLOY.md", "utf8");
const commandRoute = readFileSync("app/api/server/command/route.ts", "utf8");
const playerServer = readFileSync("../sc-server/src/player_server.rs", "utf8");
const rootReadme = readFileSync("../README.md", "utf8");
const quickstart = readFileSync("../QUICKSTART.md", "utf8");

describe("production deploy workflow", () => {
  it("uses the installed nondefault VPS key for every SSH transport", () => {
    expect(workflow).toContain("name: vps-key");
    expect(workflow).not.toMatch(/\bssh -o StrictHostKeyChecking/);
    expect(workflow).not.toMatch(/\bscp -o StrictHostKeyChecking/);
    expect(workflow.match(/-i ~\/\.ssh\/vps-key/g)?.length).toBe(8);
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
    const migration = workflow.indexOf("ON_ERROR_STOP=1", pgDump);

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
    expect(hostInstaller).toContain('mv -f "$STAGED_SERVER" "$BIN_PATH"');
    expect(publicInstaller).toContain('mktemp "$INSTALL_DIR/.sc-server.XXXXXX"');
    expect(publicInstaller).toContain('mv -f "$STAGED_SERVER" "$INSTALL_DIR/sc-server"');
    expect(rootReadme).toContain("curl -fsSL https://sprite-cloud.com/install.sh | bash");
    expect(scriptsReadme).toContain("curl -fsSL https://sprite-cloud.com/install.sh | bash");
    expect(scriptsReadme).toContain("sudo ./scripts/install.sh");
    expect(rootReadme).not.toContain("scripts/install.sh | sh -s --");
    expect(scriptsReadme).not.toContain("scripts/install.sh | sh -s --");
    expect(hostInstaller).not.toMatch(/\| sh(?:\s|$)/);
    expect(quickstart).toContain("https://sprite-cloud.com/install.sh");
    expect(quickstart).not.toContain("https://get.gamesvault.app");
  });

  it("persists setup choices through pairing and gives a direct connection URL", () => {
    expect(serverCommands).toContain("config::effective_rom_roots(existing.as_ref())");
    expect(serverCommands).toContain("core_bridge::configure_cores_dir(&cores.dir)");
    expect(serverCommands).toContain("let cfg = apply_pairing(");
    expect(serverSetup).toContain('"    {}/dashboard"');
    expect(serverSetup).toContain('join("sprite-cloud").join("cores")');
    expect(serverSetup).not.toContain('let default_cores = "/usr/lib/libretro"');
    expect(hostInstaller).toContain("${WEB_URL%/}/dashboard");
    expect(publicInstaller).toContain("https://sprite-cloud.com/dashboard");
  });

  it("keeps user systemd commands out of sudo/root sessions", () => {
    expect(serverInstall).toContain("must run as your login user, not root");
    expect(serverInstall).toContain("systemctl --user enable --now sc-server");
    expect(publicInstaller).toContain("do not use sudo with systemctl --user");
    expect(publicInstaller).toContain("sc-server install");
    expect(publicInstaller).not.toContain("sc-server --install");
    expect(hostInstaller).not.toContain('SYSTEMCTL="sudo systemctl"');
    expect(hostInstaller).toContain('if [[ -f "$CONFIG_FILE" ]]');
    expect(hostInstaller).toContain("existing config preserved");
    expect(hostInstaller).toContain(`[auth]
api_key = ""
server_id = ""`);
    expect(hostInstaller).toContain('$SUDO chown "$SU_CMD" "$CONFIG_DIR" "$CONFIG_FILE"');
  });

  it("pairs a container once without logging the pairing code", () => {
    expect(hostEntrypoint).toContain('config_file="$config_home/sprite-cloud/config.toml"');
    expect(hostEntrypoint).toContain('if [ -s "$config_file" ]');
    expect(hostEntrypoint).toContain('sc-server pair "$GV_PAIR_CODE"');
    expect(hostEntrypoint).not.toContain("auto-pairing with code $GV_PAIR_CODE");
  });

  it("publishes only after both advertised architecture builds succeed", () => {
    expect(releaseWorkflow).toContain("needs: [build-x86_64, build-aarch64]");
    expect(releaseWorkflow).not.toContain("continue-on-error: true");
    expect(releaseWorkflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(releaseWorkflow).toContain('test -f "artifacts/$arch/sc-server"');
    expect(releaseWorkflow).toContain('test -f "artifacts/$arch/sc-core"');
    expect(releaseWorkflow).toContain('for binary in sc-server sc-core');
    expect(releaseWorkflow).toContain('release-assets/$binary-$arch');
  });

  it("installs the required sc-core sibling and exposes a native upgrade command", () => {
    expect(publicInstaller).toContain('BINARIES=("sc-server" "sc-core")');
    expect(publicInstaller).toContain('"$INSTALL_DIR/sc-core"');
    expect(serverMain).toContain("Upgrade");
    expect(serverMain).toContain("upgrade::run().await");
  });

  it("pre-stages both binaries and rolls back partial replacements", () => {
    const publicCoreStage = publicInstaller.indexOf('STAGED_CORE=');
    const publicServerStage = publicInstaller.indexOf('STAGED_SERVER=');
    const publicFirstReplace = publicInstaller.indexOf('mv -f "$STAGED_CORE"');
    expect(publicCoreStage).toBeGreaterThan(-1);
    expect(publicServerStage).toBeGreaterThan(publicCoreStage);
    expect(publicFirstReplace).toBeGreaterThan(publicServerStage);
    expect(publicInstaller).toContain("rollback_install");

    const hostCoreStage = hostInstaller.indexOf('STAGED_CORE=');
    const hostServerStage = hostInstaller.indexOf('STAGED_SERVER=');
    const hostFirstReplace = hostInstaller.indexOf('mv -f "$STAGED_CORE"');
    expect(hostCoreStage).toBeGreaterThan(-1);
    expect(hostServerStage).toBeGreaterThan(hostCoreStage);
    expect(hostFirstReplace).toBeGreaterThan(hostServerStage);
    expect(hostInstaller).toContain("rollback_install");

    expect(serverUpgrade).toContain("install_staged_pair");
    expect(serverUpgrade).toContain("rollback_core");
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
    expect(ciWorkflow).toContain("cp -r sc-web/.next/standalone ./sc-web-standalone");
    expect(ciWorkflow).toContain("cp -r sc-web/.next/static ./sc-web-standalone/sc-web/.next/static");
    expect(ciDockerfile).toContain("COPY sc-web-standalone/ ./");
    expect(ciDockerfile).toContain("COPY sc-web-standalone/sc-web/.next/static/ ./sc-web/.next/static/");
    expect(ciDockerfile).toContain("COPY sc-web/public/ ./sc-web/public/");
    expect(ciDockerfile).not.toContain("COPY sc-web/.next/static/");
    expect(ciDockerfile).toContain("npm install drizzle-kit@0.31.10 postgres@3.4.9");
    expect(ciDockerfile).toContain("COPY sc-web/drizzle.config.ts ./sc-web/");
    expect(ciDockerfile).toContain("COPY sc-web/lib/db/schema.ts ./sc-web/lib/db/");
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

  it("removes public watch and keeps ordinary invitations private", () => {
    expect(existsSync("app/watch/page.tsx")).toBe(false);
    expect(existsSync("lib/public-watch.ts")).toBe(false);
    expect(existsSync("components/PublicRoomPlayer.tsx")).toBe(false);
    expect(existsSync("components/RoomInvitePlayer.tsx")).toBe(true);
    expect(homePage).not.toContain("public-watch");
    expect(landingPage).not.toContain("/watch");
    expect(landingPage).not.toMatch(/Watch Live|Try Public Demo|Watch \/ Try/);
    expect(shareRoute).not.toContain("public_");
    expect(deployScript).not.toContain("/watch");
    expect(deployGuide).not.toContain("/watch");
  });

  it("requires an explicit user action before creating a private invitation", () => {
    const gate = gamePlayer.indexOf("if (!shareRequested) return");
    const shareCall = gamePlayer.indexOf('fetch("/api/room/share"');
    expect(gamePlayer).toContain("setShareRequested(true)");
    expect(gate).toBeGreaterThan(-1);
    expect(shareCall).toBeGreaterThan(gate);
  });

  it("renders invitation QR codes locally without third-party capability disclosure", () => {
    expect(gamePlayer).toContain("<QRCodeSVG");
    expect(gamePlayer).not.toContain("api.qrserver.com");
    expect(nextConfig).not.toContain("api.qrserver.com");
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
