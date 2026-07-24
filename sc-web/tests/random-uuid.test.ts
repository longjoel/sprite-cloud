import { describe, expect, it } from "vitest";
import { randomUuid } from "@/lib/browser/random-uuid";

describe("randomUuid", () => {
  it("uses native randomUUID when available", () => {
    expect(randomUuid({ randomUUID: () => "native-uuid" })).toBe("native-uuid");
  });

  it("builds an RFC 4122 v4 UUID from getRandomValues on plain HTTP", () => {
    const cryptoLike = {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return array;
      },
    };

    expect(randomUuid(cryptoLike)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("fails closed when cryptographic randomness is unavailable", () => {
    expect(() => randomUuid({})).toThrow("Cryptographic randomness is unavailable");
  });
});
