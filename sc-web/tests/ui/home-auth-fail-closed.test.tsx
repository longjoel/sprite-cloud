import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  verifyBearerToken: vi.fn(),
  LandingPage: function LandingPage() {
    return null;
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirect:${destination}`);
  }),
}));
vi.mock("@/lib/server-auth", () => ({
  verifyBearerToken: mocks.verifyBearerToken,
}));
vi.mock("@/lib/db", () => ({
  db: { select: mocks.select },
}));
vi.mock("@/lib/db/schema", () => ({
  serverMembers: {},
  servers: {},
  users: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("@/components/LandingPage", () => ({
  default: mocks.LandingPage,
}));
vi.mock("@/components/LibraryClient", () => ({
  default: function LibraryClient() {
    return null;
  },
}));

import Home from "@/app/page";

describe("home authentication failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ error: "Configuration" });
    mocks.headers.mockResolvedValue({ get: vi.fn(() => null) });
    mocks.from.mockResolvedValue([{ count: 1 }]);
    mocks.select.mockReturnValue({ from: mocks.from });
  });

  it("treats a truthy Auth.js error object as unauthenticated", async () => {
    const result = await Home();

    expect(result.type).toBe(mocks.LandingPage);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.verifyBearerToken).not.toHaveBeenCalled();
  });
});
