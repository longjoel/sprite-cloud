"use client";

import { useState } from "react";
import { csrfHeaders, serverStatus, timeAgo } from "@/app/dashboard/dashboard-utils";
import styles from "./XmbSettings.module.css";

export interface XmbServer {
  id: string;
  name: string;
  gameCount: number;
  lastSeenAt: string | null;
  role: string;
}

export function hasXmbSettingsAccess(authenticated: boolean, servers: XmbServer[]): boolean {
  if (!authenticated) return false;
  return servers.length === 0 || servers.some((server) => server.role === "admin");
}

export default function XmbSettings({
  servers,
  onActionFocus,
}: {
  servers: XmbServer[];
  onActionFocus?: (index: number) => void;
}) {
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const hasAdminServer = servers.some((server) => server.role === "admin");

  async function generatePairingCode() {
    setPairing(true);
    setPairingCode(null);
    setPairingError(null);
    try {
      const response = await fetch("/api/auth/pair/generate", {
        method: "POST",
        headers: csrfHeaders(),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const body = await response.json();
      setPairingCode(body.code);
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing failed");
    } finally {
      setPairing(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="xmb-settings-title">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.kicker}>Settings</p>
          <h1 id="xmb-settings-title" className={styles.title}>Paired servers</h1>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            data-xmb-settings-action
            className={styles.action}
            aria-label="Generate server pairing code"
            disabled={pairing}
            onClick={generatePairingCode}
            onFocus={() => onActionFocus?.(0)}
          >
            {pairing ? "Generating…" : "Generate pairing code"}
          </button>
          {hasAdminServer && (
            <a data-xmb-settings-action className={styles.action} href="/dashboard" aria-label="Open full admin dashboard" onFocus={() => onActionFocus?.(1)}>
              Full admin dashboard
            </a>
          )}
        </div>
      </div>

      {pairingCode && (
        <div className={styles.pairing} role="status" aria-live="polite">
          <span className={styles.pairingLabel}>Pairing code</span>
          <code className={styles.code}>{pairingCode}</code>
          <code className={styles.command}>
            gv-server pair {pairingCode} --gv-web-url {window.location.origin}
          </code>
        </div>
      )}
      {pairingError && <p className={styles.error} role="alert">Pairing failed: {pairingError}</p>}

      {servers.length === 0 ? (
        <p className={styles.empty}>No paired servers. Generate a code to pair your first gv-server.</p>
      ) : (
        <ul className={styles.serverList} aria-label="Paired servers">
          {servers.map((server) => {
            const status = serverStatus(server.lastSeenAt);
            return (
              <li key={server.id} className={styles.serverRow} aria-label={`${server.name}: ${status.label}`}>
                <span className={styles.statusDot} data-status={status.label} aria-hidden="true" />
                <span className={styles.serverIdentity}>
                  <strong className={styles.serverName}>{server.name || server.id.slice(0, 8)}</strong>
                  <span className={styles.serverMeta}>
                    {server.gameCount} {server.gameCount === 1 ? "game" : "games"} · last seen {timeAgo(server.lastSeenAt)}
                  </span>
                </span>
                <span className={styles.statusLabel}>{status.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
