import { test, expect } from "@playwright/test";
import {
  openDb,
  fabricateUser,
  fabricateServer,
  fabricateMembership,
  fabricateGame,
  TEST_PASSWORD,
  cleanupAll,
} from "../lib/fabricate.ts";

// ── #745: accounts required for local play ────────────────────────────
// The server (paired with a gateway) must NOT serve the anonymous library:
// direct hits get the auth gate pushing to gateway signin. A signed-in
// member reaches the gateway dashboard and sees the shared library.
//
// NOTE: the deep WebRTC play journey (code → resolve → PlayerShell →
// nestopia) lives in multi-user.spec.ts (workflow_dispatch only, per the
// CI-cost decision). This spec is the push-CI smoke for the gate + login.

const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:3000";
const PLAYER_URL = process.env.PLAYER_URL || "http://127.0.0.1:8787";

let sql: ReturnType<typeof openDb>;
const emails: string[] = [];

test.beforeAll(async () => {
  sql = openDb();
  await cleanupAll(sql);
});

test.afterAll(async () => {
  await cleanupAll(sql);
  await sql.end();
});

test("direct hit on the server shows the auth gate, not the library", async ({
  page,
}) => {
  // #745: anonymous direct hit must NOT reach the game library.
  await page.goto(PLAYER_URL);

  // Gate markers (see auth_gate_page in player_server.rs). The h1 is the
  // server name; the body copy is the gate's fingerprint.
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("body")).toContainText(
    "requires a Sprite Cloud account",
  );
  await expect(
    page.getByRole("link", { name: /sign in at your gateway/i }),
  ).toBeVisible();

  // No anonymous library: no Play buttons, no game rows, no WebRTC page.
  await expect(page.getByRole("button", { name: /play/i })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("createDataChannel");
});

test("gate pushes to the configured gateway signin", async ({ page }) => {
  await page.goto(PLAYER_URL);
  const signin = page.getByRole("link", { name: /sign in at your gateway/i });
  const href = await signin.getAttribute("href");
  expect(href).toBe(`${GATEWAY_URL}/signin`);
});

test("member signs in at the gateway and sees the shared library", async ({
  page,
  browser,
}) => {
  // Fabricate: alice owns a server with one game; bob is an invited member.
  const stamp = Date.now();
  const aliceEmail = `alice-${stamp}@test.local`;
  const bobEmail = `bob-${stamp}@test.local`;
  emails.push(aliceEmail, bobEmail);

  const alice = await fabricateUser(sql, aliceEmail);
  const bob = await fabricateUser(sql, bobEmail);
  const server = await fabricateServer(sql, alice.id, "e2e-vault");
  await fabricateMembership(sql, server.id, alice.id, "admin");
  await fabricateMembership(sql, server.id, bob.id, "member");
  await fabricateGame(sql, server.id, "local_counter", "Counter", "NES");

  // Alice signs in through the REAL login form (NextAuth credentials).
  await page.goto(`${GATEWAY_URL}/signin`);
  await page.getByLabel(/email/i).fill(aliceEmail);
  await page.getByLabel(/password/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  // Lands on the home page — the game library. Library visibility is
  // membership-based: the shared game shows for members, not owners only.
  await expect(page.locator("body")).toContainText("Counter", { timeout: 20_000 });

  // Bob (invitee) signs in from a FRESH browser context — the realistic
  // multi-user shape (two devices), and no sign-out menu dance.
  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await bobPage.goto(`${GATEWAY_URL}/signin`);
  await bobPage.getByLabel(/email/i).fill(bobEmail);
  await bobPage.getByLabel(/password/i).fill(TEST_PASSWORD);
  await bobPage.getByRole("button", { name: /sign in/i }).click();
  await expect(bobPage.locator("body")).toContainText("Counter", { timeout: 20_000 });
  await bobContext.close();
});

test("non-member does not see a foreign server's game", async ({ page }) => {
  // stranger is NOT a member of alice's server — the shared game is
  // invisible to them (membership gate on /api/games).
  const stamp = Date.now();
  const strangerEmail = `stranger-${stamp}@test.local`;
  emails.push(strangerEmail);

  const stranger = await fabricateUser(sql, strangerEmail);
  const server = await fabricateServer(sql, stranger.id, "stranger-vault");
  await fabricateMembership(sql, server.id, stranger.id, "admin");

  await page.goto(`${GATEWAY_URL}/signin`);
  await page.getByLabel(/email/i).fill(strangerEmail);
  await page.getByLabel(/password/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  // Home renders; alice's "Counter" is NOT visible to stranger.
  await expect(page).toHaveURL(new RegExp(GATEWAY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*"));
  await expect(page.locator("body")).not.toContainText("Counter", { timeout: 20_000 });
});
