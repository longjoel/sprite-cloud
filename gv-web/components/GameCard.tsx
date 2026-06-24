"use client";

import React from "react";
import { Button, Card } from "@/components/ui";

interface Game {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
}

interface GameCardProps {
  game: Game;
  session: { user?: { name?: string | null; email?: string | null } } | null;
  hasServers: boolean;
  pickerLoading: boolean;
  editingGame: string | null;
  editName: string;
  editSaving: boolean;
  onEditNameChange: (val: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent, gameId: string) => void;
  onEditBlur: (gameId: string) => void;
  onStartRename: (game: Game) => void;
  onPlay: (gameId: string) => void;
}

export default function GameCard({
  game,
  session,
  hasServers,
  pickerLoading,
  editingGame,
  editName,
  editSaving,
  onEditNameChange,
  onEditKeyDown,
  onEditBlur,
  onStartRename,
  onPlay,
}: GameCardProps) {
  return (
    <Card key={game.id} style={{ display: "flex", flexDirection: "column" }}>
      {editingGame === game.id ? (
        <input
          type="text"
          value={editName}
          onChange={(e) => onEditNameChange(e.target.value)}
          onKeyDown={(e) => onEditKeyDown(e, game.id)}
          onBlur={() => onEditBlur(game.id)}
          disabled={editSaving}
          autoFocus
          style={styles.editInput}
          maxLength={200}
        />
      ) : (
        <div style={styles.cardTitleRow}>
          <div style={styles.cardTitle}>{game.name}</div>
          {session && (
            <button
              onClick={() => onStartRename(game)}
              style={styles.editBtn}
              title="Rename"
            >
              ✎
            </button>
          )}
        </div>
      )}
      <div style={styles.cardMeta}>{game.platform} · {game.maxPlayers}p</div>
      <div style={{ marginTop: "auto" }}>
        {session && hasServers ? (
          <Button
            variant="primary"
            onClick={() => onPlay(game.id)}
            disabled={pickerLoading}
          >
            Play
          </Button>
        ) : (
          <span style={styles.playBtnDisabled}>
            {!session ? "Sign in" : "No server"}
          </span>
        )}
      </div>
    </Card>
  );
}

const styles: Record<string, React.CSSProperties> = {
  cardTitle: {
    fontSize: "var(--font-size-lg)",
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
    marginBottom: 0,
  },
  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "var(--space-2)",
  },
  editBtn: {
    background: "none",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
    fontSize: "var(--font-size-base)",
    padding: "0 var(--space-2)",
    lineHeight: "1.4",
    fontFamily: "var(--font-mono)",
  },
  editInput: {
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-info)",
    borderRadius: "var(--radius-sm)",
    padding: "var(--space-1) var(--space-2)",
    marginBottom: "var(--space-2)",
    outline: "none",
    width: "100%",
  },
  cardMeta: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    marginBottom: "var(--space-5)",
  },
  playBtnDisabled: {
    display: "inline-block",
    padding: "4px 14px",
    background: "var(--color-walnut)",
    color: "var(--color-muted)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
};
