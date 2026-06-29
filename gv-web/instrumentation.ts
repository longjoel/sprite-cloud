/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Generates a one-time setup code for first-run admin account creation
 * so local dev (pnpm dev) and production both get a setup code without
 * needing the Docker entrypoint.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const fs = await import("fs");
    const crypto = await import("crypto");
    const path = "/tmp/gv-setup-code";

    // Only generate if no code exists yet (idempotent across restarts)
    if (!fs.existsSync(path)) {
      const code = crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(path, code);
      console.log("");
      console.log("╔══════════════════════════════════════════════╗");
      console.log("║         Sprite Cloud — First Run             ║");
      console.log("╠══════════════════════════════════════════════╣");
      console.log(`║  Setup code: ${code.padEnd(30)} ║`);
      console.log("║  Visit http://localhost:3000/setup           ║");
      console.log("╚══════════════════════════════════════════════╝");
      console.log("");
    }
  }
}
