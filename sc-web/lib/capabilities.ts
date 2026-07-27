/** Canonical player roles and their capabilities. */

export type PlayerRole = "host" | "player" | "spectator";

export interface PlayerCapabilities {
  role: PlayerRole;
  canStart: boolean;
  canStop: boolean;
  canSaveLoad: boolean;
  canDiagnose: boolean;
}

/** A server admin has full host authority for every session on their server. */
export function hostCapabilities(): PlayerCapabilities {
  return { role: "host", canStart: true, canStop: true, canSaveLoad: true, canDiagnose: true };
}

/** A guest player can join and leave — no save/load, no diagnostics. */
export function playerCapabilities(seat: number): PlayerCapabilities {
  return { role: "player", canStart: false, canStop: false, canSaveLoad: false, canDiagnose: false };
}

/** A spectator can observe only. */
export function spectatorCapabilities(): PlayerCapabilities {
  return { role: "spectator", canStart: false, canStop: false, canSaveLoad: false, canDiagnose: false };
}
