"use client";

import React from "react";
import { Badge, Button, Modal } from "@/components/ui";
import { statusVariant, capabilityVariant } from "./library-utils";

interface PlayableHost {
  server_id: string;
  name: string;
  status: string;
  has_game: boolean;
  capabilities: {
    lan: boolean;
    stun: boolean;
    turn: boolean;
  };
  role?: string;
}

interface HostPickerProps {
  open: boolean;
  hosts: PlayableHost[];
  onClose: () => void;
  onSelect: (gameId: string, serverId: string, serverName: string) => void;
  hostPickerGame: string | null;
}

export default function HostPicker({
  open,
  hosts,
  onClose,
  onSelect,
  hostPickerGame,
}: HostPickerProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose host"
    >
      {hosts.length === 0 ? (
        <p style={styles.empty}>No hosts available.</p>
      ) : (
        hosts.map((host) => {
          const playable = host.has_game && host.status !== "offline";
          return (
            <div key={host.server_id} style={styles.pickerRow}>
              <span style={styles.pickerName}>{host.name}</span>
              {host.role && (
                <Badge variant={host.role === "admin" ? "info" : "muted"}>
                  {host.role}
                </Badge>
              )}
              <Badge variant={statusVariant(host.status)}>
                {host.status}
              </Badge>
              {host.has_game && host.capabilities.lan && (
                <Badge variant="success">LAN</Badge>
              )}
              {host.has_game && host.capabilities.turn && (
                <Badge variant="warning">TURN</Badge>
              )}
              {host.has_game && host.capabilities.stun && !host.capabilities.turn && (
                <Badge variant="info">STUN</Badge>
              )}
              {!host.has_game && (
                <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                  no game
                </span>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={!playable}
                onClick={() => onSelect(hostPickerGame!, host.server_id, host.name)}
                style={{ opacity: playable ? 1 : 0.4, cursor: playable ? "pointer" : "default" }}
              >
                {playable ? "Select" : "—"}
              </Button>
            </div>
          );
        })
      )}
      <div style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-text-secondary)",
    fontStyle: "italic",
  },
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-4) 0",
    borderBottom: "1px solid var(--color-border-default)",
  },
  pickerName: {
    flex: 1,
    fontSize: "var(--font-size-md)",
    color: "var(--color-text-primary)",
    fontFamily: "var(--font-mono)",
  },
};
