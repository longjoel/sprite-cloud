import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
const mockExportAccountData = vi.fn();
const mockDeleteAccount = vi.fn();
const mockAccountDeletionBlockedError = class extends Error {
  serverIds = ["server-1"];
};

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/account-lifecycle", () => ({
  exportAccountData: mockExportAccountData,
  deleteAccount: mockDeleteAccount,
  AccountDeletionBlockedError: mockAccountDeletionBlockedError,
}));

function request(url: string, init?: RequestInit) {
  return new NextRequest(url, init as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockExportAccountData.mockResolvedValue({
    account: { id: "user-1", email: "owner@example.com", name: "Owner" },
    memberships: [],
    ownedServers: [],
    pairingCodes: [],
    createdInvites: [],
    sessions: [],
  });
  mockDeleteAccount.mockResolvedValue(undefined);
});

describe("GET /api/account/export", () => {
  it("requires an authenticated account", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/account/export/route");

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockExportAccountData).not.toHaveBeenCalled();
  });

  it("returns a downloadable export for the authenticated account", async () => {
    const { GET } = await import("@/app/api/account/export/route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("account-export.json");
    expect(mockExportAccountData).toHaveBeenCalledWith(expect.anything(), "user-1");
  });
});

describe("DELETE /api/account", () => {
  it("requires authentication and CSRF protection", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { DELETE } = await import("@/app/api/account/route");

    const response = await DELETE(request("http://localhost/api/account", { method: "DELETE" }));

    expect(response.status).toBe(401);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("rejects an authenticated request without a matching CSRF token", async () => {
    const { DELETE } = await import("@/app/api/account/route");

    const response = await DELETE(request("http://localhost/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE MY ACCOUNT" }),
    }));

    expect(response.status).toBe(403);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("requires the explicit account-deletion confirmation", async () => {
    const { DELETE } = await import("@/app/api/account/route");

    const response = await DELETE(request("http://localhost/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf", cookie: "sc_csrf_token=csrf" },
      body: JSON.stringify({ confirm: "no" }),
    }));

    expect(response.status).toBe(400);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("returns 409 with owned server IDs when deletion is blocked", async () => {
    const blocked = new mockAccountDeletionBlockedError("blocked");
    mockDeleteAccount.mockRejectedValueOnce(blocked);
    const { DELETE } = await import("@/app/api/account/route");

    const response = await DELETE(request("http://localhost/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf", cookie: "sc_csrf_token=csrf" },
      body: JSON.stringify({ confirm: "DELETE MY ACCOUNT" }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ serverIds: ["server-1"] });
  });

  it("deletes the authenticated account only after CSRF and confirmation pass", async () => {
    const { DELETE } = await import("@/app/api/account/route");

    const response = await DELETE(request("http://localhost/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf", cookie: "sc_csrf_token=csrf" },
      body: JSON.stringify({ confirm: "DELETE MY ACCOUNT" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockDeleteAccount).toHaveBeenCalledWith(expect.anything(), "user-1");
  });
});
