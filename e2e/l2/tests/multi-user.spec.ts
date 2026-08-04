/**
 * L2 multi-user isolation (#745) — the account-required play journey.
 *
 * Runs against the PAIRED harness (MULTI=1): sc-server polls commands
 * from the gateway, so the full launch→play→save path works. Two users
 * on the SAME shared server, same game:
 *
 *   alice launches counter  → her session's account_id = alice
 *   alice saveState()       → save lands in alice's stack
 *   bob   launches counter  → his session's account_id = bob
 *   bob   listSaves()       → []  (alice's saves are invisible)
 *   bob   loadStateAt(0)    → {ok:false} (fail-closed)
 *
 * The account identity comes from the gateway-enriched start_game
 * payload (user_id), never from the browser — see payload_account_id()
 * in sc-server and the finalPayload enrichment in /api/server/command.
 */
import { test, expect, Page, Browser } from "@playwright/test";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import {
  fabricateMembership,
  fabricateUser,
  TEST_PASSWORD,
} from "../lib/fabricate.js";

const GATEWAY_URL = process.env.GATEWAY_URL!;
const PLAYER_URL = process.env.PLAYER_URL!;
const DB_URL = process.env.GATEWAY_DATABASE_URL!;
const STATE_FILE = process.env.L2_STATE_FILE!;

interface HarnessState {
  server_id: string;
  api_key: string;
  owner_email: string;
  owner_password: string;
}

let state: HarnessState;
let sql: postgres.Sql;
let bobEmail: string;

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${GATEWAY_URL}/signin`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Redirect to / after successful credentials login.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 20000 });
}

/** Wait until the gateway's /api/games shows the counter fixture. */
async function waitForCounterGame(page: Page, serverId: string): Promise<string> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const id = await page.evaluate(async () => {
      const resp = await fetch("/api/games");
      if (!resp.ok) return null;
      const data = await resp.json();
      const games: Array<{ id: string; name?: string }> =
        Array.isArray(data.games) ? data.games : Array.isArray(data) ? data : [];
      const hit = games.find((g) => g.name?.toLowerCase().includes("counter"));
      return hit?.id ?? null;
    });
    if (id) return id;
    await page.waitForTimeout(500);
  }
  throw new Error("counter game never appeared in /api/games (catalog sync?)");
}

/**
 * Launch the counter game: mint a short code via /api/room/shorten (the
 * same endpoint the library's play flow calls), then navigate to /p/:code.
 * Deterministic — avoids the host-picker + LAN-probe UI path.
 */
async function launchGame(page: Page, gameId: string, serverId: string) {
  const code = await page.evaluate(async ({ gid, sid }) => {
    // CSRF: the login flow sets sc_csrf_token; read it back for the header.
    const csrf = document.cookie
      .split("; ")
      .find((c) => c.startsWith("sc_csrf_token="))
      ?.split("=")[1];
    const resp = await fetch("/api/room/shorten", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}),
      },
      body: JSON.stringify({
        game_id: gid,
        server_id: sid,
        host_token: crypto.randomUUID(),
      }),
    });
    if (!resp.ok) throw new Error(`shorten failed: ${resp.status}`);
    const data = await resp.json();
    return data.code as string;
  }, { gid: gameId, sid: serverId });

  await page.goto(`${GATEWAY_URL}/p/${code}`);
  // Player page resolves → connects → plays.
  await waitPlaying(page);
}

/** Wait for the player page to be playing (video track attached + DC open). */
async function waitPlaying(page: Page) {
  // Video attached: the relay/WebRTC pipeline is live. The <video> has no
  // id (React ref) — select by tag.
  await page.waitForFunction(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    return !!v && v.videoWidth > 0 && v.videoHeight > 0 && !!v.srcObject;
  }, { timeout: 30000 });
  // DC open: commands are actually reachable.
  await page.waitForFunction(() => {
    const p = (window as any).__scPlayer;
    return !!p && !!p._dc && p._dc.readyState === "open";
  }, { timeout: 30000 });
}

/** Call scPlay.saveState() and wait for its result message. */
async function saveState(page: Page): Promise<number> {
  return page.evaluate(() =>
    new Promise<number>((resolve, reject) => {
      const p = (window as any).__scPlayer;
      if (!p) return reject(new Error("__scPlayer missing"));
      const t = setTimeout(() => reject(new Error("save_state timeout")), 10000);
      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.cmd === "save_result") {
            clearTimeout(t);
            p._dc?.removeEventListener?.("message", onMsg);
            if (msg.ok) resolve(msg.index as number);
            else reject(new Error(`save failed: ${msg.error ?? "unknown"}`));
          }
        } catch { /* keep listening */ }
      };
      p._dc?.addEventListener?.("message", onMsg);
      const sent = (window as any).scPlay.saveState(p);
      if (!sent) { clearTimeout(t); reject(new Error("saveState not sent (dc closed?)")); }
    }),
  );
}

/** Call scPlay.listSaves() and wait for its result message. */
async function listSaves(page: Page): Promise<unknown[]> {
  return page.evaluate(() =>
    new Promise<unknown[]>((resolve, reject) => {
      const p = (window as any).__scPlayer;
      if (!p) return reject(new Error("__scPlayer missing"));
      const t = setTimeout(() => reject(new Error("list_saves timeout")), 10000);
      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.cmd === "list_saves_result") {
            clearTimeout(t);
            p._dc?.removeEventListener?.("message", onMsg);
            resolve(Array.isArray(msg.entries) ? msg.entries : []);
          }
        } catch { /* keep listening */ }
      };
      p._dc?.addEventListener?.("message", onMsg);
      const sent = (window as any).scPlay.listSaves(p);
      if (!sent) { clearTimeout(t); reject(new Error("listSaves not sent (dc closed?)")); }
    }),
  );
}

/** Call scPlay.loadStateAt(index) and wait for its result message. */
async function loadStateAt(page: Page, index: number): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate((idx) =>
    new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const p = (window as any).__scPlayer;
      if (!p) return reject(new Error("__scPlayer missing"));
      const t = setTimeout(() => reject(new Error("load_state timeout")), 10000);
      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.cmd === "load_result") {
            clearTimeout(t);
            p._dc?.removeEventListener?.("message", onMsg);
            resolve({ ok: !!msg.ok, error: msg.error });
          }
        } catch { /* keep listening */ }
      };
      p._dc?.addEventListener?.("message", onMsg);
      const sent = (window as any).scPlay.loadStateAt(p, idx);
      if (!sent) { clearTimeout(t); reject(new Error("loadStateAt not sent (dc closed?)")); }
    }),
    index,
  );
}

test.beforeAll(async () => {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  sql = postgres(DB_URL, { max: 4 });
  bobEmail = `bob-${Date.now()}@test.local`;
  const bob = await fabricateUser(sql, bobEmail);
  await fabricateMembership(sql, state.server_id, bob.id, "member");
});

test.afterAll(async () => {
  if (sql) await sql.end();
});

test("alice saves on the shared server; bob's view of the same game is empty", async ({
  browser,
}: { browser: Browser }) => {
  // ── alice launches and saves ─────────────────────────────────────
  const aliceCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  await signIn(alice, state.owner_email, state.owner_password);

  // Discover the synced counter game id, then launch.
  const gameId = await waitForCounterGame(alice, state.server_id);
  expect(gameId).toBeTruthy();
  await launchGame(alice, gameId, state.server_id);
  await waitPlaying(alice);

  // Alice's save must succeed — her session carries her account.
  const aliceIndex = await saveState(alice);
  expect(typeof aliceIndex).toBe("number");

  // ── bob launches the same game ───────────────────────────────────
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await signIn(bob, bobEmail, TEST_PASSWORD);
  await launchGame(bob, gameId, state.server_id);
  await waitPlaying(bob);

  // Bob's save list is empty: the library is shared, artifacts are not.
  const entries = await listSaves(bob);
  expect(entries).toEqual([]);

  // Fail-closed: bob cannot load alice's save index.
  const load = await loadStateAt(bob, aliceIndex);
  expect(load.ok).toBe(false);

  await bobCtx.close();
  await aliceCtx.close();
});
