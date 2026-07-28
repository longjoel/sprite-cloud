import { NextResponse } from "next/server";

// Open enrollment is intentionally disabled. Accounts are created only through
// a server-admin invitation or the zero-user first-run setup flow.
export async function POST(_request: Request) {
  return NextResponse.json(
    { error: "Open enrollment is disabled. Use an invitation link." },
    { status: 410 },
  );
}
