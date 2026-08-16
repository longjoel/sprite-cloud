import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AccountDeletionBlockedError, deleteAccount } from "@/lib/account-lifecycle";

function validCsrf(request: Request): boolean {
  const header = request.headers.get("x-csrf-token");
  const cookieHeader = request.headers.get("cookie");
  const cookie = cookieHeader
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === "sc_csrf_token")
    ?.slice(1)
    .join("=");
  if (!header || !cookie) return false;
  try {
    return header === decodeURIComponent(cookie);
  } catch {
    return false;
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!validCsrf(request)) {
    return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  }

  let body: { confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.confirm !== "DELETE MY ACCOUNT") {
    return NextResponse.json({ error: "explicit account deletion confirmation required" }, { status: 400 });
  }

  try {
    await deleteAccount(db, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountDeletionBlockedError) {
      return NextResponse.json(
        {
          error: (error.pendingCommandIds?.length ?? 0) > 0
            ? "wait for queued commands to finish before deleting the account"
            : error.activeSessionIds.length > 0
            ? "end active sessions before deleting the account"
            : "transfer or delete owned servers before deleting the account",
          serverIds: error.serverIds,
          activeSessionIds: error.activeSessionIds,
          pendingCommandIds: error.pendingCommandIds ?? [],
        },
        { status: 409 },
      );
    }
    console.error(JSON.stringify({ service: "sc-web", level: "error", msg: "account deletion failed", userId, error: String(error) }));
    return NextResponse.json({ error: "account deletion failed" }, { status: 500 });
  }
}
