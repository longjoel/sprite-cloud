"use client";

import { useParams, useSearchParams } from "next/navigation";
import GamePlayer from "@/components/GamePlayer";

export default function PlayPage() {
  const routeParams = useParams<{ game_id: string }>();
  const searchParams = useSearchParams();

  const gameId = routeParams.game_id;
  const serverId = searchParams.get("server_id") ?? "";

  if (!serverId) {
    return (
      <main style={{ ...styles.shell, background: "#000", fontFamily: "monospace", color: "#ccc" }}>
        <div style={styles.center}>
          <p>Missing connection parameters.</p>
          <p style={styles.hint}>Expected: /play/:game_id?server_id=</p>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <GamePlayer gameId={gameId} serverId={serverId} />
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    width: "100vw",
    height: "100vh",
    position: "relative",
  },
  center: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center" as const,
  },
  hint: { fontSize: 12, color: "#888", marginTop: 8 },
};
