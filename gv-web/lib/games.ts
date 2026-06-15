// ── Game catalog ────────────────────────────────────────────────────
// Hardcoded list of known games. This will eventually be replaced by
// a server-provided catalog or database table.
//
// Each entry maps a game_id (used in start_game payloads) to display
// info and core path.

export interface GameEntry {
  /** game_id used in start_game commands */
  id: string;
  /** Display name shown to the user */
  name: string;
  /** Platform / emulator */
  platform: string;
  /** Path to the libretro core */
  corePath: string;
  /** Max players (for multi-seat games) */
  maxPlayers: number;
}

const GAMES: GameEntry[] = [
  {
    id: "2048",
    name: "2048",
    platform: "Libretro",
    corePath: "test-data/cores/2048_libretro.so",
    maxPlayers: 1,
  },
];

/** List all known games. */
export function listGames(): GameEntry[] {
  return GAMES;
}

/** Look up a game by id. */
export function getGame(id: string): GameEntry | undefined {
  return GAMES.find((g) => g.id === id);
}
