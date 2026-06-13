# Phase 1: Scaffold & Pairing Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stand up all four projects with basic scaffolding, implement the pairing flow end-to-end (gv-server generates code → user enters on gv-web → pair confirmed).

**Architecture:** gv-server polls gv-web for commands. gv-web serves Next.js site with OAuth and SSE push to browser. gv-worker runs a tiny localhost HTTP server for IPC. WebRTC P2P between browser and worker, signaling proxied through gv-server → gv-web.

**Tech Stack:** Next.js 15 + React 19 (gv-web), vanilla JS (gv-player), Rust 2024 edition (gv-server, gv-worker), PostgreSQL (gv-web DB)

**Key decisions:**
- Polling: 250ms for 5s after command queued, then 2s idle
- Browser push: SSE via `EventSource`
- Worker IPC: localhost HTTP server (axum, minimal)
- Pairing codes: 8 letters, case-insensitive, 5 minute TTL
- OAuth: NextAuth.js with GitHub + Google providers

---

## Task 1: Bootstrap gv-web Next.js project

**Objective:** Get Next.js running with TypeScript and a working dev server.

**Files:**
- Modify: `gv-web/package.json`
- Create: `gv-web/next.config.ts`
- Create: `gv-web/tsconfig.json`
- Create: `gv-web/app/layout.tsx`
- Create: `gv-web/app/page.tsx`

**Step 1: Install dependencies**

```bash
cd gv-web
pnpm install
```

**Step 2: Verify dev server starts**

```bash
pnpm dev
# Visit http://localhost:3000
# Expected: "Games Vault" heading renders
```

**Step 3: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): scaffold Next.js project"
```

---

## Task 2: Add NextAuth.js with GitHub OAuth

**Objective:** Users can sign in with GitHub. Session stored in JWT.

**Files:**
- Modify: `gv-web/package.json` (add `next-auth` dep)
- Create: `gv-web/app/api/auth/[...nextauth]/route.ts`
- Create: `gv-web/lib/auth.ts`
- Create: `gv-web/.env.local`
- Modify: `gv-web/app/layout.tsx` (wrap with session provider)
- Modify: `gv-web/app/page.tsx` (show sign-in button or user name)

**Step 1: Install next-auth**

```bash
cd gv-web
pnpm add next-auth@beta
```

**Step 2: Create auth config**

```typescript
// gv-web/lib/auth.ts
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: "jwt" },
});
```

**Step 3: Create route handler**

```typescript
// gv-web/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
```

**Step 4: Update root layout**

```typescript
// gv-web/app/layout.tsx
import { SessionProvider } from "next-auth/react";
// wrap children in <SessionProvider>
```

**Step 5: Update page with auth state**

```typescript
// gv-web/app/page.tsx
import { auth, signIn, signOut } from "@/lib/auth";

export default async function Home() {
  const session = await auth();
  if (!session) {
    return <button onClick={signIn}>Sign in with GitHub</button>;
  }
  return <p>Signed in as {session.user.name}</p>;
}
```

**Step 6: Verify**

```bash
pnpm dev
# Visit http://localhost:3000
# Expected: "Sign in with GitHub" → click → GitHub OAuth → redirect back → "Signed in as ..."
```

**Step 7: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): add NextAuth.js with GitHub OAuth"
```

---

## Task 3: Set up PostgreSQL with Drizzle ORM

**Objective:** Database schema for users, devices, pairing codes, and command queue.

**Files:**
- Modify: `gv-web/package.json` (add `drizzle-orm`, `drizzle-kit`, `postgres`)
- Create: `gv-web/drizzle.config.ts`
- Create: `gv-web/lib/db/schema.ts`
- Create: `gv-web/lib/db/index.ts`
- Create: `gv-web/.env.local` (add DATABASE_URL)

**Step 1: Install dependencies**

```bash
cd gv-web
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

**Step 2: Create schema**

```typescript
// gv-web/lib/db/schema.ts
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  name: text("name").notNull().default(""),
  authToken: text("auth_token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
});

export const pairingCodes = pgTable("pairing_codes", {
  code: text("code").primaryKey(), // 8 letters, uppercase
  userId: uuid("user_id"),
  deviceId: uuid("device_id"),
  status: text("status").notNull().default("pending"), // pending | claimed | expired
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const commands = pgTable("commands", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").references(() => devices.id).notNull(),
  type: text("type").notNull(), // start_game | stop_game | sdp_offer
  payload: text("payload").notNull(), // JSON
  status: text("status").notNull().default("pending"), // pending | delivered
  createdAt: timestamp("created_at").defaultNow(),
});
```

**Step 3: Create DB client**

```typescript
// gv-web/lib/db/index.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const client = postgres(process.env.DATABASE_URL!);
export const db = drizzle(client, { schema });
```

**Step 4: Run migration**

```bash
cd gv-web
pnpm drizzle-kit push
```

**Step 5: Commit**

```bash
git add gv-web/lib/db/ gv-web/drizzle.config.ts gv-web/package.json gv-web/pnpm-lock.yaml
git commit -m "feat(gv-web): add PostgreSQL schema with Drizzle ORM"
```

---

## Task 4: Pairing code generation API

**Objective:** API endpoint to generate a pairing code. Called by gv-server (unauthenticated, device doesn't exist yet).

**Files:**
- Create: `gv-web/app/api/pair/generate/route.ts`
- Create: `gv-web/lib/pairing.ts`

**Step 1: Create pairing utility**

```typescript
// gv-web/lib/pairing.ts
import { db } from "./db";
import { pairingCodes } from "./db/schema";

// Generate 8 random uppercase letters
export function generateCode(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

export async function createPairingCode(): Promise<string> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await db.insert(pairingCodes).values({
    code,
    status: "pending",
    expiresAt,
  });

  return code;
}
```

**Step 2: Create API route**

```typescript
// gv-web/app/api/pair/generate/route.ts
import { NextResponse } from "next/server";
import { createPairingCode } from "@/lib/pairing";

export async function POST() {
  const code = await createPairingCode();
  return NextResponse.json({ code, expiresIn: 300 });
}
```

**Step 3: Test with curl**

```bash
curl -X POST http://localhost:3000/api/pair/generate
# Expected: {"code":"ABCDEFGH","expiresIn":300}
```

**Step 4: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): pairing code generation API"
```

---

## Task 5: Pairing code claim API

**Objective:** Authenticated endpoint where user enters a pairing code. Links the code to their user ID.

**Files:**
- Create: `gv-web/app/api/pair/claim/route.ts`
- Modify: `gv-web/lib/pairing.ts`

**Step 1: Add claim function**

```typescript
// Add to gv-web/lib/pairing.ts
import { eq, and } from "drizzle-orm";

export async function claimPairingCode(code: string, userId: string): Promise<boolean> {
  const normalized = code.toUpperCase();
  const result = await db
    .update(pairingCodes)
    .set({ userId, status: "claimed" })
    .where(
      and(
        eq(pairingCodes.code, normalized),
        eq(pairingCodes.status, "pending")
      )
    )
    .returning();

  return result.length > 0;
}
```

**Step 2: Create claim route**

```typescript
// gv-web/app/api/pair/claim/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { claimPairingCode } from "@/lib/pairing";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await req.json();
  if (!code || code.length !== 8) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const claimed = await claimPairingCode(code, session.user.id);
  if (!claimed) {
    return NextResponse.json({ error: "Code expired or already claimed" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
```

**Step 3: Test**

```bash
# Generate code
CODE=$(curl -s -X POST http://localhost:3000/api/pair/generate | jq -r .code)
# Claim (need auth cookie — test via browser or extract cookie)
curl -X POST http://localhost:3000/api/pair/claim \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\"}"
# Expected (without auth): 401
```

**Step 4: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): pairing code claim API"
```

---

## Task 6: Polling API (device registers with code)

**Objective:** gv-server polls this endpoint with its pairing code. When claimed, returns device_id + auth_token.

**Files:**
- Create: `gv-web/app/api/pair/poll/route.ts`
- Modify: `gv-web/lib/pairing.ts`

**Step 1: Add poll function**

```typescript
// Add to gv-web/lib/pairing.ts
import crypto from "crypto";
import { devices } from "./db/schema";

export async function pollPairingCode(
  code: string
): Promise<{ deviceId: string; authToken: string } | null> {
  const normalized = code.toUpperCase();

  // Check if code was claimed
  const pc = await db.query.pairingCodes.findFirst({
    where: and(
      eq(pairingCodes.code, normalized),
      eq(pairingCodes.status, "claimed")
    ),
  });

  if (!pc || !pc.userId) return null;

  // Create device
  const token = crypto.randomBytes(32).toString("hex");
  const [device] = await db
    .insert(devices)
    .values({
      userId: pc.userId,
      name: "",
      authToken: token,
    })
    .returning();

  // Link code to device, mark expired
  await db
    .update(pairingCodes)
    .set({ deviceId: device.id, status: "expired" })
    .where(eq(pairingCodes.code, normalized));

  return { deviceId: device.id, authToken: token };
}
```

**Step 2: Create poll route**

```typescript
// gv-web/app/api/pair/poll/route.ts
import { NextResponse } from "next/server";
import { pollPairingCode } from "@/lib/pairing";

export async function POST(req: Request) {
  const { code } = await req.json();
  if (!code || code.length !== 8) {
    return NextResponse.json({ status: "waiting" });
  }

  const result = await pollPairingCode(code);
  if (!result) {
    return NextResponse.json({ status: "waiting" });
  }

  return NextResponse.json({
    status: "paired",
    deviceId: result.deviceId,
    authToken: result.authToken,
  });
}
```

**Step 4: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): polling API for gv-server pairing"
```

---

## Task 7: Command queue API

**Objective:** gv-server polls for pending commands. gv-web queues commands from browser requests.

**Files:**
- Create: `gv-web/app/api/commands/route.ts`
- Create: `gv-web/lib/commands.ts`

**Step 1: Create commands library**

```typescript
// gv-web/lib/commands.ts
import { db } from "./db";
import { commands, devices } from "./db/schema";
import { eq, and } from "drizzle-orm";

export async function queueCommand(deviceId: string, type: string, payload: unknown) {
  await db.insert(commands).values({
    deviceId,
    type,
    payload: JSON.stringify(payload),
    status: "pending",
  });
}

export async function pollCommands(deviceId: string): Promise<Array<{ id: string; type: string; payload: unknown }>> {
  const pending = await db.query.commands.findMany({
    where: and(
      eq(commands.deviceId, deviceId),
      eq(commands.status, "pending")
    ),
    limit: 10,
  });

  // Mark as delivered
  if (pending.length > 0) {
    await db
      .update(commands)
      .set({ status: "delivered" })
      .where(eq(commands.deviceId, deviceId));
  }

  return pending.map((c) => ({
    id: c.id,
    type: c.type,
    payload: JSON.parse(c.payload),
  }));
}
```

**Step 2: Create commands route**

```typescript
// gv-web/app/api/commands/route.ts
import { NextResponse } from "next/server";
import { pollCommands } from "@/lib/commands";
import { db } from "@/lib/db";
import { devices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const device = await db.query.devices.findFirst({
    where: eq(devices.authToken, token),
  });
  if (!device) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hasPending = await db.query.commands.findFirst({
    where: eq(devices.authToken, token), // simplified — should use device id
  });

  const cmds = await pollCommands(device.id);

  return NextResponse.json({
    commands: cmds,
    pollMs: cmds.length > 0 ? 250 : 2000,
  });
}
```

**Step 3: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): command queue and polling API"
```

---

## Task 8: Browser SSE endpoint

**Objective:** Browser opens EventSource to receive SDP answers and session updates. Pushes happen when gv-server posts back.

**Files:**
- Create: `gv-web/app/api/sse/[sessionId]/route.ts`

**Step 1: Create SSE route**

```typescript
// gv-web/app/api/sse/[sessionId]/route.ts
// Use a simple in-memory emitter for MVP (replace with Redis pub/sub later)
const emitters = new Map<string, Set<(data: string) => void>>();

export function pushToSession(sessionId: string, event: string, data: unknown) {
  const subs = emitters.get(sessionId);
  if (!subs) return;
  for (const send of subs) {
    send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export async function GET(req: Request, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => controller.enqueue(new TextEncoder().encode(data));
      if (!emitters.has(sessionId)) emitters.set(sessionId, new Set());
      emitters.get(sessionId)!.add(send);

      // heartbeat
      const interval = setInterval(() => send(": heartbeat\n\n"), 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        emitters.get(sessionId)?.delete(send);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

**Step 2: Commit**

```bash
git add gv-web/
git commit -m "feat(gv-web): SSE push endpoint for browser"
```

---

## Task 9: Scaffold gv-server Rust binary

**Objective:** Minimal Rust binary that polls gv-web. Uses reqwest for HTTP, tokio for async.

**Files:**
- Modify: `gv-server/Cargo.toml` (add deps)
- Modify: `gv-server/src/main.rs`

**Step 1: Add dependencies**

```toml
# gv-server/Cargo.toml
[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rand = "0.8"
```

**Step 2: Write main polling loop**

```rust
// gv-server/src/main.rs
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const GV_WEB_URL: &str = "http://localhost:3000"; // dev; configurable later

#[derive(Debug, Serialize)]
struct PairRequest {
    code: String,
}

#[derive(Debug, Deserialize)]
struct PairResponse {
    status: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    auth_token: Option<String>,
}

#[tokio::main]
async fn main() {
    let client = Client::new();
    let code = generate_code();
    println!("Pairing code: {}", code);

    // Phase 1: Pair
    let pair_resp: PairResponse = loop {
        let resp = client
            .post(format!("{}/api/pair/poll", GV_WEB_URL))
            .json(&PairRequest {
                code: code.clone(),
            })
            .send()
            .await
            .unwrap()
            .json::<PairResponse>()
            .await
            .unwrap();

        if resp.status == "paired" {
            break resp;
        }
        println!("Waiting for pairing... (code: {})", code);
        tokio::time::sleep(Duration::from_secs(2)).await;
    };

    let auth_token = pair_resp.auth_token.unwrap();
    println!("Paired! device_id: {}", pair_resp.device_id.unwrap());

    // Phase 2: Poll for commands
    loop {
        // TODO: add command polling (Task 11)
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn generate_code() -> String {
    use rand::Rng;
    let letters: Vec<char> = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars().collect();
    let mut rng = rand::thread_rng();
    (0..8).map(|_| letters[rng.gen_range(0..letters.len())]).collect()
}
```

**Step 3: Build and run**

```bash
cd gv-server
cargo build
cargo run
# Expected: prints "Pairing code: ABCDEFGH" then "Waiting for pairing..." every 2s
```

**Step 4: Commit**

```bash
git add gv-server/
git commit -m "feat(gv-server): scaffold with pairing poll loop"
```

---

## Task 10: Scaffold gv-worker with localhost HTTP server

**Objective:** Minimal Rust binary that starts an HTTP server on a random port, accepts SDP offers.

**Files:**
- Modify: `gv-worker/Cargo.toml` (add axum)
- Modify: `gv-worker/src/main.rs`

**Step 1: Add dependencies**

```toml
# gv-worker/Cargo.toml
[dependencies]
tokio = { version = "1", features = ["full"] }
axum = "0.7"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**Step 2: Write worker entry point**

```rust
// gv-worker/src/main.rs
use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

#[derive(Debug, Deserialize)]
struct SdpOffer {
    sdp: String,
}

#[derive(Debug, Serialize)]
struct SdpAnswer {
    sdp: String,
}

async fn handle_offer(Json(offer): Json<SdpOffer>) -> Json<SdpAnswer> {
    // TODO: Actually create a peer connection and generate answer
    Json(SdpAnswer {
        sdp: format!("answer to: {}", &offer.sdp[..20.min(offer.sdp.len())]),
    })
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0); // 0 = random port

    let app = Router::new().route("/sdp", post(handle_offer));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    let actual_port = listener.local_addr().unwrap().port();

    println!("gv-worker listening on port {}", actual_port);
    axum::serve(listener, app).await.unwrap();
}
```

**Step 3: Build and test**

```bash
cd gv-worker
cargo build
cargo run 9001 &
# Test SDP endpoint
curl -X POST http://127.0.0.1:9001/sdp \
  -H "Content-Type: application/json" \
  -d '{"sdp":"test offer"}'
# Expected: {"sdp":"answer to: test offer"}
kill %1
```

**Step 4: Commit**

```bash
git add gv-worker/
git commit -m "feat(gv-worker): scaffold with localhost HTTP SDP endpoint"
```

---

## Task 11: gv-server command polling loop

**Objective:** After pairing, gv-server polls for commands and dispatches them.

**Files:**
- Modify: `gv-server/src/main.rs`

**Step 1: Add command polling types and loop**

```rust
#[derive(Debug, Deserialize)]
struct CommandResponse {
    commands: Vec<Command>,
    poll_ms: u64,
}

#[derive(Debug, Deserialize)]
struct Command {
    id: String,
    #[serde(rename = "type")]
    cmd_type: String,
    payload: serde_json::Value,
}

// In main(), after pairing:
let mut poll_ms = 2000u64;
loop {
    let resp = client
        .get(format!("{}/api/commands", GV_WEB_URL))
        .header("Authorization", format!("Bearer {}", auth_token))
        .send()
        .await
        .unwrap()
        .json::<CommandResponse>()
        .await
        .unwrap();

    poll_ms = resp.poll_ms;

    for cmd in resp.commands {
        match cmd.cmd_type.as_str() {
            "start_game" => {
                println!("Starting game: {:?}", cmd.payload);
                // TODO: spawn gv-worker
            }
            _ => println!("Unknown command: {}", cmd.cmd_type),
        }
    }

    tokio::time::sleep(Duration::from_millis(poll_ms)).await;
}
```

**Step 2: Verify**

```bash
cd gv-server
cargo build
# Expected: compiles cleanly
```

**Step 3: Commit**

```bash
git add gv-server/
git commit -m "feat(gv-server): command polling loop with adaptive interval"
```

---

## Task 12: gv-player scaffold

**Objective:** Minimal JS module that connects to SSE and renders video.

**Files:**
- Modify: `gv-player/index.js`
- Modify: `gv-player/package.json`

**Step 1: Write player module**

```javascript
// gv-player/index.js
export class GameVaultPlayer {
  constructor(sessionId, videoElement) {
    this.sessionId = sessionId;
    this.video = videoElement;
  }

  connect() {
    const es = new EventSource(`/api/sse/${this.sessionId}`);
    es.addEventListener("sdp", (e) => {
      const { sdp } = JSON.parse(e.data);
      // TODO: apply SDP answer to RTCPeerConnection
      console.log("received SDP:", sdp.substring(0, 30));
    });
    es.addEventListener("error", () => {
      console.log("SSE disconnected, reconnecting...");
    });
    this.eventSource = es;
  }

  disconnect() {
    this.eventSource?.close();
  }
}
```

**Step 2: JS syntax check**

```bash
node -c gv-player/index.js
# Expected: no errors
```

**Step 3: Commit**

```bash
git add gv-player/
git commit -m "feat(gv-player): SSE-based player scaffold"
```

---

## Verification Checklist

- [ ] `pnpm dev` starts gv-web on :3000
- [ ] GitHub OAuth sign-in works
- [ ] `POST /api/pair/generate` returns 8-letter code
- [ ] `POST /api/pair/claim` (authenticated) claims the code
- [ ] `POST /api/pair/poll` returns waiting, then paired after claim
- [ ] `cargo run` in gv-server prints pairing code and waits
- [ ] After entering code on gv-web, gv-server prints "Paired!"
- [ ] `GET /api/commands` returns empty commands with pollMs=2000
- [ ] `cargo run` in gv-worker starts HTTP server, responds to SDP
- [ ] `node -c gv-player/index.js` passes

---

## Next Phase (not in this plan)

- gv-server spawns gv-worker with actual libretro core
- Browser creates WebRTC offer → gv-web queues → gv-server proxies to worker
- Worker generates actual SDP answer → flows back through gv-server → gv-web → browser SSE
- WebRTC P2P video between browser and worker
- TURN fallback configuration
- ROM library scanning and indexing
