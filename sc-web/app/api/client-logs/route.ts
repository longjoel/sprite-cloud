import { NextRequest, NextResponse } from "next/server";

const MAX_BODY_BYTES = 256_000;
const MAX_EVENTS = 50;
const MAX_STRING = 2_000;
const MAX_MESSAGE = 4_000;

function clampString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clampNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return clampString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[MaxDepth]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeUnknown(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value).slice(0, 20)) {
      out[key] = sanitizeUnknown(inner, depth + 1);
    }
    return out;
  }
  return clampString(String(value));
}

function extractIp(req: NextRequest): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return clampString(forwarded || req.headers.get("x-real-ip") || undefined, 120);
}

type ClientEvent = {
  ts?: string;
  level?: string;
  type?: string;
  message?: string;
  args?: unknown[];
  detail?: unknown;
  context?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  try {
    const bodyText = await req.text();
    if (!bodyText) {
      return NextResponse.json({ error: "empty body" }, { status: 400 });
    }
    if (bodyText.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const rawEvents = Array.isArray(payload.events) ? payload.events.slice(0, MAX_EVENTS) : [];
    const sessionId = clampString(payload.sessionId, 120);
    const sentAt = clampString(payload.sentAt, 64);
    const droppedEvents = clampNumber(payload.droppedEvents);
    const requestIp = extractIp(req);
    const userAgent = clampString(req.headers.get("user-agent") || undefined, 300);
    const topContext = sanitizeUnknown(payload.context);

    let accepted = 0;
    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as ClientEvent;
      const level = clampString(event.level, 24) || "log";
      const message = clampString(event.message, MAX_MESSAGE) || "[browser log]";
      const type = clampString(event.type, 64) || "console";
      const args = Array.isArray(event.args) ? sanitizeUnknown(event.args) : undefined;
      const detail = sanitizeUnknown(event.detail);
      const context = sanitizeUnknown(event.context);

      console.log(JSON.stringify({
        service: "sc-web",
        source: "browser",
        msg: message,
        level,
        type,
        sessionId,
        sentAt,
        requestIp,
        userAgent,
        droppedEvents,
        eventTs: clampString(event.ts, 64),
        context: topContext,
        eventContext: context,
        args,
        detail,
      }));
      accepted += 1;
    }

    return NextResponse.json({ ok: true, accepted });
  } catch (error) {
    console.error("client log ingest error:", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
