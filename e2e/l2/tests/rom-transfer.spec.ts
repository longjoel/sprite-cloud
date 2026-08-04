/**
 * ROM transfer E2E verification (#631).
 *
 * Exercises the complete browser → signaling → WebRTC → host filesystem
 * pipeline. Uses the L2 paired harness (fabricated-paired.ts creates the
 * server + config; this spec adds admin/member users as members).
 *
 * Run: ROM_TRANSFER=1 bash e2e/l2/run-l2.sh
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, fabricateUser, fabricateMembership } from "../lib/fabricate.ts";
import {
  createTransferCreds,
  uploadRomInBrowser,
  downloadRomInBrowser,
  bytesToBase64,
  generateTestRom,
  generateLargeTestRom,
} from "../lib/rom-transfer-harness.ts";

const BASE = process.env.GATEWAY_URL ?? "http://127.0.0.1:3000";
const WORK = process.env.L2_WORK_DIR!;

interface PairedState { server_id: string; api_key: string; owner_email: string; owner_password: string; }
function readPairedState(): PairedState {
  return JSON.parse(readFileSync(join(WORK, "state.json"), "utf8"));
}

// ── Setup ──────────────────────────────────────────────────────────────

let sql: ReturnType<typeof openDb>;
let serverId: string;
let admin: { id: string; email: string; password: string };
let member: { id: string; email: string; password: string };
let testRom: { bytes: Uint8Array; sha256: string; b64: string };

test.beforeAll(async () => {
  const paired = readPairedState();
  serverId = paired.server_id;
  sql = openDb();
  admin = await fabricateUser(sql, `rom-admin-631-${Date.now()}@test.local`);
  member = await fabricateUser(sql, `rom-member-631-${Date.now()}@test.local`);
  await fabricateMembership(sql, serverId, admin.id, "admin");
  await fabricateMembership(sql, serverId, member.id, "member");

  const rom = generateTestRom();
  testRom = { bytes: rom.bytes, sha256: rom.sha256, b64: bytesToBase64(rom.bytes) };
});

test.afterAll(async () => {
  await sql.end();
});

// ── Helpers ────────────────────────────────────────────────────────────
async function loginAs(page: import("@playwright/test").Page, email: string, password: string) {
  // Clear any stale session from previous tests in same browser context
  await page.context().clearCookies();
  await page.goto(`${BASE}/signin`);
  await page.getByLabel(/email/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("text=Sign out")).toBeVisible({ timeout: 10_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────

test("round-trip upload + download preserves SHA-256", async ({ page }) => {
  await loginAs(page, admin.email, admin.password);

  // Upload
  const creds = await createTransferCreds(page, serverId, "test-631.nes", testRom.bytes.length);
  const result = await uploadRomInBrowser(page, serverId, creds, testRom.b64, "test-631.nes");

  expect(result.hash).toBe(testRom.sha256);
  expect(result.size).toBe(testRom.bytes.length);
  expect(result.game_id).toBeTruthy();

  // Download and verify
  const dl = await downloadRomInBrowser(page, serverId, result.game_id!);
  expect(dl.sha256).toBe(testRom.sha256);
  expect(Buffer.from(dl.bytesB64, "base64").equals(testRom.bytes)).toBe(true);
});

test("member cannot create transfer", async ({ page }) => {
  await loginAs(page, member.email, member.password);
  await expect(
    createTransferCreds(page, serverId, "blocked.nes", 1024),
  ).rejects.toThrow(/403|administrator|Transfer auth failed/);
});

test("guest cannot create transfer", async ({ page }) => {
  const guest = await fabricateUser(sql, "rom-guest-631@test.local");
  await loginAs(page, guest.email, guest.password);
  await expect(
    createTransferCreds(page, serverId, "blocked.nes", 1024),
  ).rejects.toThrow(/403|administrator|Transfer auth failed/);
});

test("path traversal basename rejected", async ({ page }) => {
  await loginAs(page, admin.email, admin.password);
  await expect(
    createTransferCreds(page, serverId, "../etc/passwd", 1024),
  ).rejects.toThrow(/path|separator|null/);
});

test("unsupported extension rejected", async ({ page }) => {
  await loginAs(page, admin.email, admin.password);
  await expect(
    createTransferCreds(page, serverId, "malware.exe", 1024),
  ).rejects.toThrow(/extension|unsupported/);
});

test("oversized declared_size rejected", async ({ page }) => {
  await loginAs(page, admin.email, admin.password);
  const tooBig = 2 * 1024 * 1024 * 1024 + 1;
  await expect(
    createTransferCreds(page, serverId, "big.nes", tooBig),
  ).rejects.toThrow(/size|limit|exceed/);
});

test("large file upload preserves SHA-256", async ({ page }) => {
  await loginAs(page, admin.email, admin.password);

  const largeRom = generateLargeTestRom(4 * 1024 * 1024, 0xab);
  const largeB64 = bytesToBase64(largeRom.bytes);

  const creds = await createTransferCreds(page, serverId, "large-test.nes", largeRom.bytes.length);
  const result = await uploadRomInBrowser(page, serverId, creds, largeB64, "large-test.nes");

  expect(result.hash).toBe(largeRom.sha256);
  expect(result.size).toBe(largeRom.bytes.length);

  const dl = await downloadRomInBrowser(page, serverId, result.game_id!);
  expect(dl.sha256).toBe(largeRom.sha256);

  // Page should still be responsive
  expect(await page.title()).toBeTruthy();
});
