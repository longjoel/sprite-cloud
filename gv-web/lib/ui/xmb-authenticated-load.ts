import { normalizeRecentGameIds } from "@/lib/ui/library-view-model";

type FetchResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

type XmbAuthenticatedLoadOptions<TBootstrap> = {
  signal: AbortSignal;
  fetcher: (input: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
  setBootstrap: (bootstrap: TBootstrap) => void;
  setRecentIds: (ids: string[]) => void;
};

export async function loadXmbAuthenticatedData<TBootstrap>({
  signal,
  fetcher,
  setBootstrap,
  setRecentIds,
}: XmbAuthenticatedLoadOptions<TBootstrap>): Promise<void> {
  try {
    if (signal.aborted) return;
    const bootstrapResponse = await fetcher("/api/client/bootstrap", { signal });
    if (signal.aborted || !bootstrapResponse.ok) return;

    const bootstrap = await bootstrapResponse.json() as TBootstrap;
    if (signal.aborted) return;
    setBootstrap(bootstrap);

    if (signal.aborted) return;
    const recentResponse = await fetcher("/api/recent-plays", { signal });
    if (signal.aborted || !recentResponse.ok) return;

    const recent = await recentResponse.json();
    if (signal.aborted) return;
    setRecentIds(normalizeRecentGameIds(recent));
  } catch (error) {
    if (!signal.aborted) {
      // These optional dashboard requests must not prevent the XMB from loading.
    }
  }
}
