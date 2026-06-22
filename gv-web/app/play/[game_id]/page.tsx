"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import GamePlayer from "@/components/GamePlayer";

export default function PlayPage() {
  const routeParams = useParams<{ game_id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const gameId = routeParams.game_id;
  const serverId = searchParams.get("server_id") ?? "";
  const joinToken = searchParams.get("join") ?? "";

  const [joinLoading, setJoinLoading] = useState(!!joinToken);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [resolvedServerId, setResolvedServerId] = useState(serverId);

  // ── Join flow: resolve room_token → worker_url + server_id ──────────

  const resolveJoin = useCallback(async () => {
    if (!joinToken) return;

    setJoinLoading(true);
    try {
      const resp = await fetch("/api/room/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_token: joinToken }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        setJoinError(data.error || `Join failed (HTTP ${resp.status})`);
        return;
      }

      if (!data.worker_url) {
        setJoinError("Session not ready yet");
        return;
      }

      // Use the server_id from the join response — the GamePlayer
      // will pick up the join token from the URL to authenticate.
      setResolvedServerId(data.server_id || "__join__");
      setJoinLoading(false);
    } catch {
      setJoinError("Network error — check your connection");
      setJoinLoading(false);
    }
  }, [joinToken]);

  useEffect(() => {
    resolveJoin();
  }, [resolveJoin]);

  // ── Server validation (skip for guest joins) ─────────────────────────

  const [validating, setValidating] = useState(!!serverId && !joinToken);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId || joinToken) return;

    (async () => {
      try {
        const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
        if (resp.status === 401) { setServerError("Sign in to play"); return; }
        if (!resp.ok) { setServerError("Failed to check server status"); return; }
        const data = await resp.json();
        const host = (data.hosts || []).find((h: any) => h.server_id === serverId);
        if (!host) { setServerError("Server not found"); return; }
        if (!host.has_game) { setServerError("Game not available on this server"); return; }
        if (host.status === "offline") { setServerError("Server is offline"); return; }
      } catch {
        setServerError("Network error checking server");
      } finally {
        setValidating(false);
      }
    })();
  }, [serverId, gameId, joinToken]);

  // ── Expired session recovery ─────────────────────────────────────────

  const [recoveryHosts, setRecoveryHosts] = useState<any[] | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  useEffect(() => {
    if (!joinError || !gameId) return;

    (async () => {
      setRecoveryLoading(true);
      try {
        const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
        if (resp.status === 401) { setRecoveryHosts([]); return; }
        if (resp.ok) {
          const data = await resp.json();
          const online = (data.hosts || []).filter(
            (h: any) => h.has_game && h.status !== "offline",
          );
          setRecoveryHosts(online);
        }
      } catch { /* silently ignore */ }
      finally { setRecoveryLoading(false); }
    })();
  }, [joinError, gameId]);

  // ── Missing parameters ───────────────────────────────────────────────

  if (!joinToken && !serverId) {
    return (
      <main style={{ ...styles.shell, background: "#000" }}>
        <div style={styles.center}>
          <p style={styles.text}>Missing connection parameters.</p>
          <p style={styles.hint}>Expected: /play/:game_id?server_id= or ?join=</p>
        </div>
      </main>
    );
  }

  // ── Join loading ─────────────────────────────────────────────────────

  if (joinLoading) {
    return (
      <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
        <div style={styles.center}>
          <p style={styles.text}>Joining game…</p>
          <p style={styles.hint}>Resolving invite link…</p>
        </div>
      </main>
    );
  }

  // ── Join error with recovery ──────────────────────────────────────────

  if (joinError) {
    return (
      <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
        <div style={styles.center}>
          <p style={{ ...styles.text, color: "var(--color-muted)" }}>
            Session expired or not found
          </p>
          {recoveryLoading && (
            <p style={styles.hint}>Looking for available servers…</p>
          )}
          {recoveryHosts !== null && recoveryHosts.length === 0 && (
            <p style={styles.hint}>No servers available for this game</p>
          )}
          {recoveryHosts !== null && recoveryHosts.length === 1 && (
            <a
              href={`/play/${gameId}?server_id=${recoveryHosts[0].server_id}`}
              style={{
                ...styles.text,
                color: "var(--color-neon-cyan)",
                textDecoration: "underline",
                cursor: "pointer",
                marginTop: "var(--space-4)",
                display: "inline-block",
              }}
            >
              Start new session
            </a>
          )}
          {recoveryHosts !== null && recoveryHosts.length > 1 && (
            <>
              <p style={{ ...styles.hint, marginTop: "var(--space-4)" }}>
                Choose a server:
              </p>
              {recoveryHosts.map((h: any) => (
                <a
                  key={h.server_id}
                  href={`/play/${gameId}?server_id=${h.server_id}`}
                  style={{
                    ...styles.hint,
                    color: "var(--color-neon-cyan)",
                    display: "block",
                    marginTop: "var(--space-2)",
                  }}
                >
                  {h.name || h.server_id}
                </a>
              ))}
            </>
          )}
          <a
            href="/"
            style={{ ...styles.hint, marginTop: 16, display: "block" }}
          >
            ← Back to Library
          </a>
        </div>
      </main>
    );
  }

  // ── Server validation states ──────────────────────────────────────────

  if (validating) {
    return (
      <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
        <div style={styles.center}>
          <p style={styles.text}>Checking server…</p>
        </div>
      </main>
    );
  }

  if (serverError) {
    // Determine which step failed
    const stepState = (id: string): string => {
      if (id === "ice") return "done";
      if (id === "server") return serverError.includes("offline") || serverError.includes("not found") ? "failed" : "done";
      if (id === "game") return serverError.includes("not available") ? "failed" : "pending";
      return "pending";
    };
    const stepDot = (state: string) =>
      state === "done" ? "✓" : state === "failed" ? "✖" : "○";
    const stepBg = (state: string) =>
      state === "done" ? "var(--color-success)" :
      state === "failed" ? "var(--color-error)" : "var(--color-walnut)";
    const stepColor = (state: string) =>
      state === "failed" ? "var(--color-error)" :
      state === "done" ? "var(--color-success)" : "var(--color-muted)";

    return (
      <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
        <div style={styles.center}>
          <p style={styles.text}>Could not start game</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-5)", marginBottom: "var(--space-4)" }}>
            {["ice","server","game","worker","handshake","connected"].map((id) => {
              const s = stepState(id);
              const label = id.charAt(0).toUpperCase() + id.slice(1);
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, borderRadius: "50%", fontSize: 11,
                    fontFamily: "var(--font-mono)", color: "#000", fontWeight: 700,
                    background: stepBg(s),
                  }}>{stepDot(s)}</span>
                  <span style={{ fontSize: "var(--font-size-sm)", fontFamily: "var(--font-mono)", color: stepColor(s) }}>{label}</span>
                </div>
              );
            })}
          </div>
          <p style={{ ...styles.hint, color: "var(--color-error)" }}>
            {serverError}
          </p>
          <a href="/" style={styles.hint}>← Back to Library</a>
        </div>
      </main>
    );
  }

  // ── Render player ────────────────────────────────────────────────────

  return (
    <main style={styles.shell}>
      <GamePlayer
        gameId={gameId}
        serverId={resolvedServerId}
        initialPipeline={{ ice: "done", server: "done", game: "done", worker: "active" }}
        onClose={() => router.push("/")}
      />
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    width: "100vw",
    height: "100vh",
    position: "relative",
  },
  center: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center" as const,
  },
  text: {
    fontFamily: "var(--font-mono)",
    color: "var(--color-cream)",
    fontSize: "var(--font-size-md)",
  },
  hint: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    marginTop: "var(--space-4)",
  },
};
