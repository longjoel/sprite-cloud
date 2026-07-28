import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Legacy setup enrollment is disabled. Use the first-run invitation link." },
    { status: 410 },
  );
}
