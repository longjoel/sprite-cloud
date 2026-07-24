export type LanProbeReason =
  | "no_urls"
  | "mixed_content_blocked"
  | "timeout"
  | "fetch_failed"
  | "http_error"
  | "invalid_response";

export interface LanHealthPayload {
  status?: string;
  service?: string;
  lan_player?: boolean;
  version?: string;
  server_id?: string;
  user_id?: string;
  server_name?: string;
  bind?: string;
}

export interface LanProbeReachable {
  reachable: true;
  url: string;
  latencyMs: number;
  serverId?: string;
  userId?: string;
  serverName?: string;
  version?: string;
  payload: LanHealthPayload;
}

export interface LanProbeUnreachable {
  reachable: false;
  reason: LanProbeReason;
  url?: string;
  latencyMs?: number;
  status?: number;
  error?: string;
}

export type LanProbeResult = LanProbeReachable | LanProbeUnreachable;

interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pageProtocol?: string;
}

function currentPageProtocol(): string {
  if (typeof window !== "undefined" && window.location?.protocol) {
    return window.location.protocol;
  }
  return "http:";
}

function isMixedContentBlocked(url: URL, pageProtocol: string): boolean {
  return pageProtocol === "https:" && url.protocol === "http:";
}

function isValidHealthPayload(value: unknown): value is LanHealthPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as LanHealthPayload;
  return payload.status === "ok" && payload.lan_player === true;
}

async function probeOne(url: string, options: Required<ProbeOptions>): Promise<LanProbeResult> {
  const started = options.now();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reachable: false, reason: "invalid_response", url, error: "invalid URL" };
  }

  if (isMixedContentBlocked(parsed, options.pageProtocol)) {
    return {
      reachable: false,
      reason: "mixed_content_blocked",
      url,
      latencyMs: options.now() - started,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });
    const latencyMs = options.now() - started;

    if (!response.ok) {
      return { reachable: false, reason: "http_error", url, status: response.status, latencyMs };
    }

    const payload = (await response.json()) as unknown;
    if (!isValidHealthPayload(payload)) {
      return { reachable: false, reason: "invalid_response", url, latencyMs };
    }

    return {
      reachable: true,
      url,
      latencyMs,
      payload,
      serverId: payload.server_id,
      userId: payload.user_id,
      serverName: payload.server_name,
      version: payload.version,
    };
  } catch (error) {
    const latencyMs = options.now() - started;
    const name = error instanceof Error ? error.name : "";
    return {
      reachable: false,
      reason: name === "AbortError" ? "timeout" : "fetch_failed",
      url,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeLanHealth(
  urls: string[] | undefined,
  options: ProbeOptions = {},
): Promise<LanProbeResult> {
  const candidates = (urls ?? []).filter((url) => url.trim().length > 0);
  if (candidates.length === 0) {
    return { reachable: false, reason: "no_urls" };
  }

  const resolvedOptions: Required<ProbeOptions> = {
    timeoutMs: options.timeoutMs ?? 1_200,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? (() => performance.now()),
    pageProtocol: options.pageProtocol ?? currentPageProtocol(),
  };

  // Fast pre-probe: try the first URL with a 300ms timeout.
  // If a remote host doesn't answer in 300ms, skip the remaining URLs
  // instead of burning 1200ms per URL on unreachable targets.
  if (candidates.length > 1) {
    const quickOptions = { ...resolvedOptions, timeoutMs: 300 };
    const quickResult = await probeOne(candidates[0], quickOptions);
    if (!quickResult.reachable) {
      // Mixed-content blocked is instant — still worth trying other URLs
      // (e.g. one might be HTTPS). All other failures mean the host is
      // likely remote — don't waste time on the rest.
      if (quickResult.reason !== "mixed_content_blocked") {
        return quickResult;
      }
    }
  }

  let lastFailure: LanProbeUnreachable | null = null;
  for (const url of candidates) {
    const result = await probeOne(url, resolvedOptions);
    if (result.reachable) return result;
    lastFailure = result;
  }

  return lastFailure ?? { reachable: false, reason: "no_urls" };
}
