"use client";

import { useRef, useEffect, useState } from "react";
import { Card, Badge } from "@fluentui/react-components";
import { Star20Regular, Star20Filled, Edit20Regular, Pin20Regular, Pin20Filled, MoreHorizontal20Regular, Desktop20Regular } from "@fluentui/react-icons";
import { getPlatformColor } from "@/lib/platformColors";

interface GameTileProps {
  game: { id: string; name: string; platform: string; maxPlayers: number };
  size?: "square" | "wide" | "large";
  isFavorite?: boolean;
  isPinned?: boolean;
  onPlay: (gameId: string) => void;
  onToggleFavorite?: (gameId: string, e: React.MouseEvent) => void;
  onTogglePin?: (gameId: string, e: React.MouseEvent) => void;
  onEdit?: (game: { id: string; name: string; platform: string; maxPlayers: number }) => void;
  onChooseHost?: (gameId: string) => void;
  launching?: boolean;
}

const sizeClassMap = { square: "tile-square", wide: "tile-wide", large: "tile-large" } as const;

export default function GameTile({ game, size = "square", isFavorite = false, isPinned = false, onPlay, onToggleFavorite, onTogglePin, onEdit, onChooseHost, launching = false }: GameTileProps) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = nameRef.current;
    if (element) setOverflows(element.scrollWidth > element.clientWidth);
  }, [game.name]);

  const stop = (action: (event: React.MouseEvent) => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action(event);
  };
  const favoriteLabel = isFavorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`;
  const pinLabel = isPinned ? `Unpin ${game.name}` : `Pin ${game.name}`;

  const actions = (mobile = false) => (
    <div className={mobile ? "game-tile-overflow-actions" : "game-tile-secondary-actions"}>
      {onToggleFavorite && (
        <button aria-label={favoriteLabel} title={favoriteLabel} onClick={stop((event) => onToggleFavorite(game.id, event))}>
          {isFavorite ? <Star20Filled /> : <Star20Regular />}{mobile && <span>{isFavorite ? "Remove favorite" : "Favorite"}</span>}
        </button>
      )}
      {onTogglePin && (
        <button aria-label={pinLabel} title={pinLabel} onClick={stop((event) => onTogglePin(game.id, event))}>
          {isPinned ? <Pin20Filled /> : <Pin20Regular />}{mobile && <span>{isPinned ? "Unpin" : "Pin"}</span>}
        </button>
      )}
      {onEdit && (
        <button aria-label={`Rename ${game.name}`} title={`Rename ${game.name}`} onClick={stop(() => onEdit(game))}>
          <Edit20Regular />{mobile && <span>Rename</span>}
        </button>
      )}
      {onChooseHost && (
        <button disabled={launching} aria-label={`Choose host for ${game.name}`} title={`Choose host for ${game.name}`} onClick={stop(() => onChooseHost(game.id))}>
          <Desktop20Regular /><span>{mobile ? "Choose host…" : "Host"}</span>
        </button>
      )}
    </div>
  );

  return (
    <Card focusMode="off" className={`game-tile ${sizeClassMap[size]} ${isFavorite ? "is-favorite" : ""} ${isPinned ? "is-pinned" : ""}`.trim()} appearance="filled-alternative" style={{ userSelect: "none", background: getPlatformColor(game.platform) }}>
      <button disabled={launching} className="game-tile-play-target" aria-label={`Play ${game.name}`} onClick={() => onPlay(game.id)}>
        {launching && <span>Launching…</span>}
      </button>
      <Badge appearance="tint" color="informative" className="game-tile-platform">{game.platform}</Badge>
      {actions()}
      <details className="game-tile-overflow" onClick={(event) => event.stopPropagation()}>
        <summary aria-label={`More actions for ${game.name}`}><MoreHorizontal20Regular /></summary>
        {actions(true)}
      </details>
      <div className="game-tile-caption">
        <span ref={nameRef} className={`game-tile-name${overflows ? "" : " no-overflow"}`}>{game.name}</span>
        <span className="game-tile-platform-text">{game.platform}</span>
      </div>
    </Card>
  );
}
