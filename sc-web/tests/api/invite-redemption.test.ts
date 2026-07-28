import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/invites/[code]/route";

const code = "A".repeat(32);
const context = { params: Promise.resolve({ code }) };

function malformedRequest(sequence: number) {
  return new NextRequest(`http://localhost/api/invites/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `198.51.100.${sequence}`,
      "x-csrf-token": "test-csrf",
      Cookie: "sc_csrf_token=test-csrf",
    },
    body: "{",
  });
}

describe("invite redemption boundary", () => {
  it("rejects anonymous redemption without the double-submit CSRF token", async () => {
    const request = new NextRequest(`http://localhost/api/invites/${code}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Player", email: "player@example.com", password: "password123" }),
    });
    const response = await POST(request, context);
    expect(response.status).toBe(403);
  });

  it("rate-limits enrollment attempts before password hashing or database work", async () => {
    const ipSequence = 77;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await POST(malformedRequest(ipSequence), context);
      expect(response.status).toBe(400);
    }

    const blocked = await POST(malformedRequest(ipSequence), context);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
