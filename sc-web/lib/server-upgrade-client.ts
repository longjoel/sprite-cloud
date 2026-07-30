export type ServerUpdateState = "queued" | "running" | "done" | "failed";

interface CommandResult {
  status: string;
  result?: { ok?: boolean; restarting?: boolean; error?: string };
  error?: string;
}

type Fetcher = typeof fetch;
type StateReporter = (state: ServerUpdateState, message: string) => void;

export async function runServerUpgrade(
  serverId: string,
  headers: HeadersInit,
  report: StateReporter,
  fetcher: Fetcher = fetch,
  sleep: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1_000)),
): Promise<void> {
  report("queued", "Waiting for the server to accept the update…");
  try {
    const response = await fetcher(`/api/servers/${serverId}/upgrade`, { method: "POST", headers });
    const body = await response.json() as { command_id?: string; error?: string };
    if (!response.ok || !body.command_id) throw new Error(body.error ?? `HTTP ${response.status}`);

    for (let attempt = 0; attempt < 180; attempt += 1) {
      await sleep();
      const resultResponse = await fetcher(`/api/commands/${body.command_id}/result`);
      if (!resultResponse.ok) continue;
      const result = await resultResponse.json() as CommandResult;
      if (result.status === "pending") continue;
      if (result.status === "leased") {
        report("running", "Downloading and verifying sc-server and sc-core…");
        continue;
      }
      if (result.status === "completed" && result.result?.ok && result.result.restarting) {
        report("done", "Updated and restarting. The server will reconnect shortly.");
        return;
      }
      throw new Error(result.result?.error ?? result.error ?? "update failed");
    }
    throw new Error("update timed out waiting for the server");
  } catch (cause) {
    report("failed", cause instanceof Error ? cause.message : "update failed");
  }
}
