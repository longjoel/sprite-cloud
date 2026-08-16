import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

type JwtToken = Record<string, unknown> & { sub?: string };
type AuthDb = typeof db;

/** Remove the claims of a token whose account no longer exists. */
export async function revokeDeletedUserToken(token: JwtToken, database: AuthDb = db): Promise<JwtToken> {
  if (!token.sub) return token;

  const [user] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, token.sub))
    .limit(1);

  return user ? token : {};
}
