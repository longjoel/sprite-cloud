interface LoadingPageProps {
  label?: string;
}

export default function LoadingPage({ label = "Loading…" }: LoadingPageProps) {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.spinner} aria-hidden="true" />
        <p style={styles.label}>{label}</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-sky-deep)",
    padding: "24px",
  },
  card: {
    minWidth: "220px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    padding: "24px",
    border: "1px solid var(--color-border-default)",
    background: "var(--color-surface-default)",
    borderRadius: "2px",
  },
  spinner: {
    width: "28px",
    height: "28px",
    borderRadius: "999px",
    border: "2px solid var(--color-border-default)",
    borderTopColor: "var(--color-accent)",
    animation: "sc-spin 1s linear infinite",
  },
  label: {
    margin: 0,
    color: "var(--color-text-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
};
