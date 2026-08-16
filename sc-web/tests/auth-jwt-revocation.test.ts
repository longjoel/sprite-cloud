import { describe, it, expect, vi } from "vitest";
import { revokeDeletedUserToken } from "@/lib/jwt-revocation";

function databaseReturning(rows: unknown[]) {
  const query = Promise.resolve(rows) as Promise<unknown[]> & {
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  };
  query.from = vi.fn().mockReturnValue(query);
  query.where = vi.fn().mockReturnValue(query);
  query.limit = vi.fn().mockReturnValue(query);
  return { select: vi.fn().mockReturnValue(query) };
}

describe("revokeDeletedUserToken", () => {
  it("preserves a token while its account exists", async () => {
    const token = { sub: "user-1", email: "owner@example.com" };
    const database = databaseReturning([{ id: "user-1" }]);

    await expect(revokeDeletedUserToken(token, database as any)).resolves.toEqual(token);
  });

  it("returns an empty token when the account has been deleted", async () => {
    const database = databaseReturning([]);

    await expect(revokeDeletedUserToken({ sub: "deleted-user" }, database as any)).resolves.toEqual({});
  });

  it("does not query the database for an anonymous token", async () => {
    const database = databaseReturning([]);

    await expect(revokeDeletedUserToken({}, database as any)).resolves.toEqual({});
    expect(database.select).not.toHaveBeenCalled();
  });
});
