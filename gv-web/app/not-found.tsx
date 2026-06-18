export default function NotFound() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        background: "var(--color-mahogany)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <h1 style={{ color: "var(--color-cream)", fontSize: "var(--font-size-h1)" }}>
        404 — Not Found
      </h1>
    </div>
  );
}
