import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox } from "../src/server/crypto.js";

describe("secret box", () => {
  it("round-trips a secret without embedding plaintext", () => {
    const box = createSecretBox(randomBytes(32));
    const encrypted = box.encrypt("sensitive-password");

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("sensitive-password");
    expect(box.decrypt(encrypted)).toBe("sensitive-password");
  });

  it("rejects tampered ciphertext", () => {
    const box = createSecretBox(randomBytes(32));
    const encrypted = box.encrypt("sensitive-password");
    const last = encrypted.at(-1);
    const tampered = `${encrypted.slice(0, -1)}${last === "A" ? "B" : "A"}`;

    expect(() => box.decrypt(tampered)).toThrow();
  });
});
