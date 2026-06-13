const emitters = new Map<string, Set<(data: string) => void>>();

export function pushToSession(
  sessionId: string,
  event: string,
  data: unknown
) {
  const subs = emitters.get(sessionId);
  if (!subs) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of subs) {
    send(payload);
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) =>
        controller.enqueue(new TextEncoder().encode(data));
      if (!emitters.has(sessionId)) emitters.set(sessionId, new Set());
      emitters.get(sessionId)!.add(send);

      const keepalive = setInterval(() => send(": heartbeat\n\n"), 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        emitters.get(sessionId)?.delete(send);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
