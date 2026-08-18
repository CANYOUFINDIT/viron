import { describe, expect, it } from "vitest";
import { createClientId } from "../src/client/client-id";

describe("createClientId", () => {
  it("uses randomUUID when the browser exposes it", () => {
    const cryptoApi = { randomUUID: () => "preferred-id" } as unknown as Crypto;
    expect(createClientId(cryptoApi)).toBe("preferred-id");
  });

  it("falls back to getRandomValues on non-secure HTTP origins", () => {
    const cryptoApi = {
      getRandomValues: (target: Uint8Array) => {
        target.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return target;
      },
    } as unknown as Crypto;

    expect(createClientId(cryptoApi)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
