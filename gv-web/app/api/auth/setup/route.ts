import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import fs from "fs";

const SETUP_CODE_PATH = "/tmp/gv-setup-code";

// POST /api/auth/setup — create the first (admin) user with setup code validation

export async function POST(req: NextRequest) {
  try {
    // Only allow if zero users exist
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);

    if (Number(row?.count ?? 0) > 0) {
      return NextResponse.json(
        { error: "Setup already completed" },
        { status: 403 },
      );
    }

    // Read the setup code
    let storedCode: string;
    try {
      storedCode = fs.readFileSync(SETUP_CODE_PATH, "utf-8").trim();
    } catch {
      return NextResponse.json(
        { error: "Setup code not available — restart the server" },
        { status: 400 },
      );
    }

    if (!storedCode) {
      return NextResponse.json(
        { error: "Setup code not available" },
        { status: 400 },
      );
    }

    const { name, email, password, code } = await req.json();

    if (!code || code.trim() !== storedCode) {
      return NextResponse.json(
        { error: "Invalid setup code" },
        { status: 401 },
      );
    }

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 },
      );
    }

    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@") || normalized.length < 5) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    if (password.length < 4) {
      return NextResponse.json(
        { error: "Password must be at least 4 characters" },
        { status: 400 },
      );
    }

    const hash = await bcrypt.hash(password, 10);
    const displayName = (name || normalized.split("@")[0]).trim();

    const [user] = await db
      .insert(users)
      .values({ email: normalized, name: displayName, passwordHash: hash })
      .returning({ id: users.id, name: users.name, email: users.email });

    // Invalidate the setup code — it's one-time use
    try {
      fs.writeFileSync(SETUP_CODE_PATH, "", "utf-8");
    } catch { /* ok */ }

    console.log(JSON.stringify({
      service: "gv-web",
      msg: "setup complete — first admin user created",
      email: normalized,
    }));

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (err) {
    console.error("setup error:", err);
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 },
    );
  }
}
