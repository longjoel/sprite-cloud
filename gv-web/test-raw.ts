import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  try {
    const result = await sql`SELECT * FROM commands LIMIT 1`;
    console.log("OK:", result);
  } catch (e: any) {
    console.error("ERR:", e.message);
  }
  await sql.end();
  process.exit(0);
}

main();
