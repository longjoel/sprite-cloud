(() => {
  if (typeof window === "undefined") return;
  if (window.__gvBrowserLog?.installed) return;

  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const SESSION_ID = (() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `gv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  })();

  const MAX_QUEUE = 100;
  const MAX_BATCH = 25;
  const MAX_STRING = 2000;
  const MAX_MESSAGE = 4000;
  const MAX_EVENTS_PER_WINDOW = 250;
  const WINDOW_MS = 30_000;
  const DUP_LIMIT = 10;
  const DUP_WINDOW_MS = 15_000;
  const FLUSH_INTERVAL_MS = 2_000;
  const FLUSH_URL = "/api/client-logs";

  const queue = [];
  const recentEvents = [];
  const duplicateCounts = new Map();
  let flushTimer = null;
  let sending = false;
  let droppedEvents = 0;
  let suppressionNoticeScheduled = false;

  function now() {
    return Date.now();
  }

  function clampString(value, max = MAX_STRING) {
    if (value == null) return undefined;
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function safeSerialize(value, depth = 0, seen = new WeakSet()) {
    if (value == null) return value;
    if (typeof value === "string") return clampString(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: clampString(value.message),
        stack: clampString(value.stack, MAX_MESSAGE),
      };
    }
    if (value instanceof Event) {
      return {
        type: value.type,
        target: value.target && value.target.tagName ? value.target.tagName : undefined,
      };
    }
    if (depth >= 3) return "[MaxDepth]";
    if (typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (Array.isArray(value)) {
        return value.slice(0, 10).map((item) => safeSerialize(item, depth + 1, seen));
      }
      const out = {};
      for (const [key, inner] of Object.entries(value).slice(0, 20)) {
        out[key] = safeSerialize(inner, depth + 1, seen);
      }
      return out;
    }
    try {
      return clampString(JSON.stringify(value));
    } catch {
      return clampString(String(value));
    }
  }

  function formatArgs(args) {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
        try {
          return JSON.stringify(safeSerialize(arg));
        } catch {
          return String(arg);
        }
      })
      .join(" ")
      .slice(0, MAX_MESSAGE);
  }

  function baseContext() {
    const nav = navigator;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    const searchParams = new URLSearchParams(location.search);
    return {
      href: clampString(location.href, 500),
      path: clampString(location.pathname, 200),
      query: clampString(location.search, 500),
      page: location.pathname.startsWith("/player") ? "player" : "app",
      roomToken: clampString(searchParams.get("join") || "", 120) || undefined,
      peerToken: clampString(searchParams.get("peer_token") || "", 120) || undefined,
      serverId: clampString(searchParams.get("server_id") || "", 120) || undefined,
      role: clampString(searchParams.get("role") || "", 32) || undefined,
      seat: clampString(searchParams.get("seat") || "", 8) || undefined,
      userAgent: clampString(nav.userAgent, 300),
      language: clampString(nav.language, 32),
      online: nav.onLine,
      visibilityState: document.visibilityState,
      referrer: clampString(document.referrer, 300) || undefined,
      connection: connection
        ? {
            effectiveType: clampString(connection.effectiveType, 32),
            type: clampString(connection.type, 32),
            rtt: typeof connection.rtt === "number" ? connection.rtt : undefined,
            downlink: typeof connection.downlink === "number" ? connection.downlink : undefined,
          }
        : undefined,
    };
  }

  const dynamicContext = {};

  function currentContext() {
    return {
      ...baseContext(),
      ...dynamicContext,
    };
  }

  function withinRateLimit() {
    const cutoff = now() - WINDOW_MS;
    while (recentEvents.length && recentEvents[0] < cutoff) recentEvents.shift();
    if (recentEvents.length >= MAX_EVENTS_PER_WINDOW) return false;
    recentEvents.push(now());
    return true;
  }

  function duplicateKey(level, message) {
    return `${level}:${message.slice(0, 300)}`;
  }

  function shouldSuppressDuplicate(level, message) {
    const key = duplicateKey(level, message);
    const ts = now();
    const entry = duplicateCounts.get(key);
    if (!entry || ts - entry.windowStart > DUP_WINDOW_MS) {
      duplicateCounts.set(key, { count: 1, windowStart: ts });
      return false;
    }
    entry.count += 1;
    if (entry.count <= DUP_LIMIT) return false;
    return true;
  }

  function enqueue(event) {
    if (!withinRateLimit()) {
      droppedEvents += 1;
      return;
    }

    if (shouldSuppressDuplicate(event.level, event.message || "")) {
      droppedEvents += 1;
      if (!suppressionNoticeScheduled) {
        suppressionNoticeScheduled = true;
        queue.push({
          ts: new Date().toISOString(),
          level: "warn",
          type: "browser-log-suppression",
          message: "browser log rate limit / duplicate suppression active",
          droppedEvents,
          context: currentContext(),
        });
      }
      scheduleFlush(250);
      return;
    }

    if (queue.length >= MAX_QUEUE) {
      queue.shift();
      droppedEvents += 1;
    }
    queue.push(event);
    if (queue.length >= MAX_BATCH) flushSoon();
    else scheduleFlush();
  }

  function scheduleFlush(delay = FLUSH_INTERVAL_MS) {
    if (flushTimer !== null) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flush(false);
    }, delay);
  }

  function flushSoon() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flush(false);
  }

  async function flush(useBeacon) {
    if (sending || queue.length === 0) return;
    sending = true;
    const events = queue.splice(0, MAX_BATCH);
    const payload = {
      sessionId: SESSION_ID,
      sentAt: new Date().toISOString(),
      context: currentContext(),
      droppedEvents,
      events,
    };
    suppressionNoticeScheduled = false;

    try {
      const body = JSON.stringify(payload);
      if (useBeacon && typeof navigator.sendBeacon === "function") {
        const ok = navigator.sendBeacon(
          FLUSH_URL,
          new Blob([body], { type: "application/json" }),
        );
        if (!ok) queue.unshift(...events);
      } else {
        const resp = await fetch(FLUSH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
          credentials: "same-origin",
        });
        if (!resp.ok) queue.unshift(...events);
      }
    } catch {
      queue.unshift(...events);
    } finally {
      sending = false;
      if (queue.length > 0) scheduleFlush(1_000);
    }
  }

  function capture(level, args, extra = {}) {
    const serializedArgs = args.map((arg) => safeSerialize(arg));
    enqueue({
      ts: new Date().toISOString(),
      level,
      type: extra.type || "console",
      message: clampString(formatArgs(args), MAX_MESSAGE),
      args: serializedArgs,
      detail: extra.detail ? safeSerialize(extra.detail) : undefined,
      context: currentContext(),
    });
  }

  ["log", "info", "warn", "error", "debug"].forEach((level) => {
    const original = originalConsole[level];
    console[level] = (...args) => {
      original(...args);
      capture(level, args);
    };
  });

  window.addEventListener("error", (event) => {
    enqueue({
      ts: new Date().toISOString(),
      level: "error",
      type: "window-error",
      message: clampString(event.message || "Unhandled window error", MAX_MESSAGE),
      detail: safeSerialize({
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error,
      }),
      context: currentContext(),
    });
    scheduleFlush(250);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error
      ? event.reason.stack || `${event.reason.name}: ${event.reason.message}`
      : typeof event.reason === "string"
        ? event.reason
        : JSON.stringify(safeSerialize(event.reason));
    enqueue({
      ts: new Date().toISOString(),
      level: "error",
      type: "unhandledrejection",
      message: clampString(reason || "Unhandled promise rejection", MAX_MESSAGE),
      detail: safeSerialize(event.reason),
      context: currentContext(),
    });
    scheduleFlush(250);
  });

  window.addEventListener("pagehide", () => {
    void flush(true);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });

  window.__gvBrowserLog = {
    installed: true,
    sessionId: SESSION_ID,
    flush: () => flush(false),
    capture: (level, ...args) => capture(level, args),
    setContext: (patch) => {
      if (!patch || typeof patch !== "object") return;
      Object.assign(dynamicContext, safeSerialize(patch));
    },
  };
})();
