# ROM Transfer E2E Verification (#631)

> **Closes #621** — the remaining closure gate for the ROM transfer epic.

**Goal:** Prove the complete browser → signaling → WebRTC → host filesystem path with byte-for-byte SHA-256 round-trips, negative auth/filesystem cases, and route observability.

**Architecture:** L2-style paired harness (fabricated server + admin user + member user, Postgres, sc-web, sc-server). Playwright drives the real browser WebRTC stack via `page.evaluate()`. Temp ROM roots isolate test files from production.

**Tech Stack:** Playwright (Chrome), Node.js with postgres/lib for DB fabrication, bash for harness orchestration.

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Auth bypass | Test member/guest cannot create transfer | Task 4 |
| Path traversal | Test `../`, symlink escape, null bytes rejected | Task 5 |
| Capability replay/expiry | Test expired+replayed capabilities fail closed | Task 4 |
| Size limit bypass | Test oversized files rejected | Task 5 |
| Cross-server transfer | Test wrong server_id rejected | Task 4 |
| Partial commit | Test disconnect/cancel leaves no playable file | Task 5 |

---

## Task 1: Add ROM transfer Playwright spec scaffold

**Files:**
- Create: `e2e/l2/tests/rom-transfer.spec.ts`
- Modify: `e2e/l2/run-l2.sh` (add ROM transfer mode)

**What:** Stand up the same paired harness as auth-gate/multi-user tests, then add an `ROM_TRANSFER=1` mode that copies `rom-transfer.spec.ts` into the test dir. Stub a single happy-path "round-trip upload + download preserves SHA-256" test that fabricates a server + admin, creates a Playwright page, logs in, and verifies the page loads.

The spec reuses `lib/fabricate.ts` for DB setup and `run-l2.sh` for the full topology. ROM roots point to a temp directory created in the harness.

---

## Task 2: Implement upload via browser WebRTC in the test harness

**Files:**
- Create: `e2e/l2/lib/rom-transfer-harness.ts`
- Modify: `e2e/l2/tests/rom-transfer.spec.ts`

**What:** Create a harness module that, given a Playwright `page` and credentials, executes the complete upload flow inside the browser using `page.evaluate()`:

1. Fetch ICE config from `/api/ice-config`
2. Create `RTCPeerConnection` + DataChannel (`rom-transfer-v1`)
3. POST SDP offer to `/api/servers/{id}/rom-transfers/{tid}/offer`
4. Poll `/api/commands/{cid}/result` for SDP answer
5. Auth via DataChannel (`{cmd: "auth", capability_secret}`)
6. Stream file bytes in 16KB chunks through DataChannel
7. Send `{cmd: "transfer_complete"}`, await `{cmd: "transfer_ok"}`

The harness accepts: `page`, `serverId`, `transferCreds`, file `Uint8Array`, `filename`.

Use a known test ROM (a small generated binary with known SHA-256, not a production file).

---

## Task 3: Implement download and round-trip verification

**Files:**
- Modify: `e2e/l2/lib/rom-transfer-harness.ts` (add `downloadRomBytes`)
- Modify: `e2e/l2/tests/rom-transfer.spec.ts`

**What:** The download path is HTTP-based (queue command, poll for result URL, download). Implement:

1. `POST /api/servers/{id}/rom-downloads` with `{game_id}`
2. Poll for the download URL
3. Fetch the URL, read the response as bytes
4. Compute SHA-256 in the browser (`crypto.subtle.digest`)
5. Return `{sha256, size, bytes}`

Wire the round-trip test:
- Upload test ROM → get `{hash, size, game_id}`
- Download by `game_id` → get bytes
- Verify SHA-256 matches
- Verify library refresh (game appears in `/api/servers/{id}/games`)

---

## Task 4: Add auth negative cases

**Files:**
- Modify: `e2e/l2/tests/rom-transfer.spec.ts`

**What:** Add Playwright tests that verify:

1. **Member cannot create transfer** — fabricate member user, login, POST to rom-transfers → 403
2. **Guest (no membership) cannot create transfer** — login, no server membership → 403
3. **Wrong server** — admin of server A, POST to server B's rom-transfers → 403
4. **Expired capability** — create transfer, wait for short expiry, try to offer SDP → 410
5. **Replayed capability** — create transfer, use it, try to reuse the same capability_secret → rejected

Use `page.evaluate()` for API calls with cookie-based auth from logged-in pages.

---

## Task 5: Add filesystem safety negative cases

**Files:**
- Modify: `e2e/l2/tests/rom-transfer.spec.ts`

**What:** Test filesystem boundary enforcement via the API layer:

1. **Path traversal basename** — `POST` with `basename: "../etc/passwd"` → 400
2. **Null byte basename** — `POST` with `basename: "game\x00.nes"` → 400
3. **Unsupported extension** — `POST` with `basename: "malware.exe"` → 400
4. **Oversized declared_size** — `POST` with `declared_size: 3 * 1024 * 1024 * 1024` → 400
5. **Disconnect mid-transfer** — start upload, close page before completion → verify no `.partial` committed to library

All negative cases must leave no playable files in the temp ROM root.

---

## Task 6: Add route observability and large-file memory assertion

**Files:**
- Modify: `e2e/l2/tests/rom-transfer.spec.ts`

**What:**

1. **Route selection logging** — after upload, inspect sc-server logs for `ice_candidate_pair_selected` or equivalent to confirm ICE route. Assert the selected candidate type is logged (at minimum, direct ICE works in loopback).

2. **Backpressure/large file** — generate a 4MB sparse file (repeating pattern), upload, and assert:
   - Transfer completes successfully
   - SHA-256 round-trip matches
   - No out-of-memory crash in browser or server (page stays responsive)

---

## Task 7: Update deployment documentation

**Files:**
- Modify: `docs/TESTING.md`

**What:** Add a "ROM Transfer Smoke" section with:
- Reproducible `ROM_TRANSFER=1 bash e2e/l2/run-l2.sh` command
- Expected output (test count, pass/fail)
- Required dependencies (same as L2 auth-gate)
- Notes on ROM root isolation (temp dir, no production files touched)
