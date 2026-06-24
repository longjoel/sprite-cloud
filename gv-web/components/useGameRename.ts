"use client";

import { useState, useCallback } from "react";

interface Game {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
}

export function useGameRename(games: Game[], csrfHeadersFn: () => Record<string, string>) {
  const [editingGame, setEditingGame] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const startRename = useCallback((game: Game) => {
    setEditingGame(game.id);
    setEditName(game.name);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingGame(null);
    setEditName("");
  }, []);

  const saveRename = useCallback(async (gameId: string) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === games.find((g) => g.id === gameId)?.name) {
      cancelRename();
      return;
    }
    setEditSaving(true);
    try {
      const resp = await fetch(`/api/games/${gameId}`, {
        method: "PUT",
        headers: csrfHeadersFn(),
        body: JSON.stringify({ name: trimmed }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const idx = games.findIndex((g) => g.id === gameId);
      if (idx !== -1) games[idx].name = trimmed;
      cancelRename();
    } catch {
      setEditSaving(false);
    }
  }, [editName, games, cancelRename, csrfHeadersFn]);

  const handleEditKey = useCallback((e: React.KeyboardEvent, gameId: string) => {
    if (e.key === "Enter") saveRename(gameId);
    if (e.key === "Escape") cancelRename();
  }, [saveRename, cancelRename]);

  return {
    editingGame,
    editName,
    setEditName,
    editSaving,
    startRename,
    cancelRename,
    saveRename,
    handleEditKey,
  };
}
