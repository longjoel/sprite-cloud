/**
 * Pre-step for the L2 multi-user journey (paired mode): fabricate the
 * server row + owner + game, then write the sc-server paired config.
 *
 * The multi-user spec needs a REAL paired server (command polling) —
 * standalone mode never polls the gateway, so the launch→play→save
 * journey cannot work there. This script runs BEFORE sc-server starts
 * and writes:
 *   $L2_WORK_DIR/config.toml          (sc_web.url + auth.api_key/server_id)
 *   $L2_WORK_DIR/state.json           (server id + owner creds for the spec)
 */
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fabricateMembership,
  fabricateServer,
  fabricateUser,
  TEST_PASSWORD,
} from "./fabricate.ts";

const dbUrl = process.env.GATEWAY_DATABASE_URL;
if (!dbUrl) throw new Error("GATEWAY_DATABASE_URL not set");
const workDir = process.env.L2_WORK_DIR;
if (!workDir) throw new Error("L2_WORK_DIR not set");
const gatewayUrl = process.env.GATEWAY_URL;
if (!gatewayUrl) throw new Error("GATEWAY_URL not set");

const sql = postgres(dbUrl, { max: 4 });
try {
  const owner = await fabricateUser(sql, `owner-${Date.now()}@test.local`);
  const server = await fabricateServer(sql, owner.id, "e2e-vault");
  await fabricateMembership(sql, server.id, owner.id, "admin");

  // sc-server paired config (dirs::config_dir() honors XDG_CONFIG_HOME).
  const cfgDir = join(workDir, "sprite-cloud");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "config.toml"),
    [
      `[sc_web]`,
      `url = "${gatewayUrl}"`,
      ``,
      `[auth]`,
      `api_key = "${server.apiKey}"`,
      `server_id = "${server.id}"`,
      ``,
    ].join("\n"),
  );

  writeFileSync(
    join(workDir, "state.json"),
    JSON.stringify({
      server_id: server.id,
      api_key: server.apiKey,
      owner_email: owner.email,
      owner_password: TEST_PASSWORD,
    }),
  );
  console.log("paired server fabricated + config written");
} finally {
  await sql.end();
}
