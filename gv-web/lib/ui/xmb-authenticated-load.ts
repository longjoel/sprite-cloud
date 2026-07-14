type FetchResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export interface XmbCanonicalData {
  favoriteIds: Set<string>;
  pinnedIds: Set<string>;
  recentGames: Array<{ id: string; playedAt: string }>;
}

export interface PinnedGameRow {
  id: string;
  name: string;
  platform: string;
  serverId: string;
  maxPlayers: number | null;
}

type XmbAuthenticatedLoadOptions<TBootstrap> = {
  signal: AbortSignal;
  fetcher: (input: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
  setBootstrap: (bootstrap: TBootstrap) => void;
  setFavoriteIds: (ids: Set<string>) => void;
  setPinnedIds: (ids: Set<string>) => void;
  setRecentGames: (games: Array<{ id: string; playedAt: string }>) => void;
  setPinnedGamesList?: (games: PinnedGameRow[]) => void;
};

interface BootstrapLibraryShape {
  totalGames?: number;
  pinnedCount?: number;
  favoriteIds?: string[];
  pinnedIds?: string[];
  recentGames?: Array<{ id: string; playedAt: string }>;
  pinnedGames?: PinnedGameRow[];
}

export async function loadXmbAuthenticatedData<TBootstrap>({
  signal,
  fetcher,
  setBootstrap,
  setFavoriteIds,
  setPinnedIds,
  setRecentGames,
  setPinnedGamesList,
}: XmbAuthenticatedLoadOptions<TBootstrap>): Promise<void> {
  try {
    if (signal.aborted) return;
    const bootstrapResponse = await fetcher("/api/client/bootstrap", { signal });
    if (signal.aborted || !bootstrapResponse.ok) return;

    const bootstrap = await bootstrapResponse.json() as TBootstrap & { library?: BootstrapLibraryShape };
    if (signal.aborted) return;
    setBootstrap(bootstrap);

    // Extract canonical data from the bootstrap library object
    const lib = bootstrap.library;
    setFavoriteIds(new Set(lib?.favoriteIds ?? []));
    setPinnedIds(new Set(lib?.pinnedIds ?? []));
    setRecentGames(lib?.recentGames ?? []);
    setPinnedGamesList?.(lib?.pinnedGames ?? []);
  } catch (error) {
    if (!signal.aborted) {
      // These optional dashboard requests must not prevent the XMB from loading.
    }
  }
}
