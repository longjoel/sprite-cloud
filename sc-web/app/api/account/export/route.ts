import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { exportAccountData } from "@/lib/account-lifecycle";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const data = await exportAccountData(db, userId);
  return NextResponse.json(data, {
    status: 200,
    headers: {
      "Content-Disposition": "attachment; filename=account-export.json",
      "Cache-Control": "no-store",
    },
  });
}
