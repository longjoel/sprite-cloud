import Link from "next/link";
import { redirect } from "next/navigation";
import { resolvePublicWatchPath } from "@/lib/public-watch";

export const dynamic = "force-dynamic";

export default async function WatchPage() {
  const publicPath = await resolvePublicWatchPath();
  if (publicPath) {
    redirect(publicPath);
  }

  return (
    <main style={s.page}>
      <div style={s.card}>
        <div style={s.kicker}>Public demo</div>
        <h1 style={s.title}>No live public session right now.</h1>
        <p style={s.body}>
          The permanent watch link is online, but there is not an active shared game at this moment.
          Try again in a bit, or sign in and launch your own session.
        </p>
        <div style={s.row}>
          <Link href="/" style={s.secondary}>Back home</Link>
          <Link href="/signin" style={s.primary}>Sign in</Link>
        </div>
      </div>
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-sky-deep)",
    color: "var(--color-cloud)",
    padding: "24px",
    fontFamily: "var(--font-mono)",
  },
  card: {
    width: "100%",
    maxWidth: "640px",
    padding: "32px",
    background: "rgba(17,24,39,0.82)",
    border: "1px solid rgba(56,189,248,0.16)",
  },
  kicker: {
    color: "var(--color-accent)",
    fontSize: "var(--font-size-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "12px",
  },
  title: {
    margin: 0,
    fontSize: "var(--font-size-xl)",
  },
  body: {
    margin: "16px 0 0",
    color: "var(--color-cloud-dim)",
    lineHeight: 1.6,
  },
  row: {
    display: "flex",
    gap: "12px",
    marginTop: "24px",
  },
  primary: {
    padding: "12px 24px",
    background: "var(--color-accent)",
    color: "var(--color-sky-deep)",
    textDecoration: "none",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 700,
  },
  secondary: {
    padding: "12px 24px",
    border: "1px solid rgba(56,189,248,0.3)",
    color: "var(--color-accent)",
    textDecoration: "none",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
}
