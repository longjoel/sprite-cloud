type FetchResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

type XmbAuthenticatedLoadOptions<TBootstrap> = {
  signal: AbortSignal;
  fetcher: (input: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
  setBootstrap: (bootstrap: TBootstrap) => void;
};

export async function loadXmbAuthenticatedData<TBootstrap>({
  signal,
  fetcher,
  setBootstrap,
}: XmbAuthenticatedLoadOptions<TBootstrap>): Promise<void> {
  try {
    if (signal.aborted) return;
    const response = await fetcher("/api/client/bootstrap", { signal });
    if (signal.aborted || !response.ok) return;

    const bootstrap = await response.json() as TBootstrap;
    if (!signal.aborted) setBootstrap(bootstrap);
  } catch {
    // Optional dashboard metadata must not prevent the XMB from loading.
  }
}
