import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  ROM_TRANSFER_CHANNEL_LABEL,
  parseRomTransferServerMessage,
} from "@/lib/rom-transfer-client";

interface FixtureMessage {
  name: string;
  message: unknown;
}

interface ProtocolFixtures {
  channel: { valid: string; invalid: string[] };
  valid_server_controls: FixtureMessage[];
  invalid_server_controls: FixtureMessage[];
}

const fixtures = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../protocol/fixtures/rom-transfer-v1.json"),
    "utf8",
  ),
) as ProtocolFixtures;

describe("rom-transfer-v1 server control validation", () => {
  it("uses the fixture-defined versioned channel label", () => {
    expect(ROM_TRANSFER_CHANNEL_LABEL).toBe(fixtures.channel.valid);
    expect(fixtures.channel.invalid).not.toContain(ROM_TRANSFER_CHANNEL_LABEL);
  });

  it.each(fixtures.valid_server_controls)("accepts $name", ({ message }) => {
    expect(parseRomTransferServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each(fixtures.invalid_server_controls)("rejects $name", ({ message }) => {
    expect(() => parseRomTransferServerMessage(JSON.stringify(message))).toThrow(
      /invalid rom transfer control message/i,
    );
  });

  it("rejects oversized control metadata before parsing", () => {
    const oversized = JSON.stringify({
      cmd: "transfer_error",
      reason: "x".repeat(MAX_CONTROL_MESSAGE_BYTES),
    });
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
      MAX_CONTROL_MESSAGE_BYTES,
    );
    expect(() => parseRomTransferServerMessage(oversized)).toThrow(
      /control message too large/i,
    );
  });
});
