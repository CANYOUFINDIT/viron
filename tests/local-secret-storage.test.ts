import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptLocalSecret,
  encryptLocalSecret,
  isLocalSecretCiphertext,
  localSecretKeyPath,
} from "../src/desktop/local-secret-storage.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "viron-local-secret-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("macOS local secret storage", () => {
  it("encrypts with a per-installation key and decrypts only in the same context", async () => {
    const directory = await temporaryDirectory();
    const encrypted = encryptLocalSecret(directory, "private-value", "device:one");

    expect(isLocalSecretCiphertext(encrypted)).toBe(true);
    expect(encrypted).not.toContain("private-value");
    expect(decryptLocalSecret(directory, encrypted, "device:one")).toBe("private-value");
    expect(() => decryptLocalSecret(directory, encrypted, "device:two")).toThrow();
  });

  it("creates a 32-byte owner-only key file and preserves it across encryptions", async () => {
    const directory = await temporaryDirectory();
    encryptLocalSecret(directory, "first", "agent:one");
    const path = localSecretKeyPath(directory);
    const firstKey = readFileSync(path);
    encryptLocalSecret(directory, "second", "agent:two");

    expect(firstKey).toHaveLength(32);
    expect(readFileSync(path)).toEqual(firstKey);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects tampered ciphertext and missing or invalid key files", async () => {
    const directory = await temporaryDirectory();
    const encrypted = encryptLocalSecret(directory, "private-value", "device:one");
    const [prefix, encoded] = encrypted.split(":", 2);
    const payload = Buffer.from(encoded, "base64url");
    payload[payload.length - 1] ^= 1;
    const tampered = `${prefix}:${payload.toString("base64url")}`;
    expect(() => decryptLocalSecret(directory, tampered, "device:one")).toThrow();

    const key = localSecretKeyPath(directory);
    writeFileSync(key, "short");
    chmodSync(key, 0o600);
    expect(() => decryptLocalSecret(directory, encrypted, "device:one")).toThrow("Viron 本机密钥文件无效");

    const otherDirectory = await temporaryDirectory();
    expect(() => decryptLocalSecret(otherDirectory, encrypted, "device:one")).toThrow("Viron 本机密钥文件不存在");
  });
});
