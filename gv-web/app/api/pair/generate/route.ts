import { NextResponse } from "next/server";
import { createPairingCode } from "@/lib/pairing";

export async function POST() {
  const code = await createPairingCode();
  return NextResponse.json({ code, expiresIn: 300 });
}
