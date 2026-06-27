import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// POST /api/auth/signup — create a new user account

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
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

    // Check if user already exists
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 },
      );
    }

    const hash = await bcrypt.hash(password, 10);
    const name = normalized.split("@")[0];

    const [user] = await db
      .insert(users)
      .values({ email: normalized, name, passwordHash: hash })
      .returning({ id: users.id, name: users.name, email: users.email });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (err) {
    console.error("signup error:", err);
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 },
    );
  }
}
