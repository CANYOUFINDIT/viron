import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCAL_SECRET_PREFIX = "viron-local-v1:";
const LOCAL_SECRET_KEY_BYTES = 32;
const LOCAL_SECRET_IV_BYTES = 12;
const LOCAL_SECRET_TAG_BYTES = 16;
const LOCAL_SECRET_KEY_FILE = ".local-secret-key";

function keyPath(userDataPath: string): string {
  return join(userDataPath, LOCAL_SECRET_KEY_FILE);
}

function validateKey(key: Buffer): Buffer {
  if (key.length !== LOCAL_SECRET_KEY_BYTES) throw new Error("Viron 本机密钥文件无效");
  return key;
}

function readKey(userDataPath: string): Buffer {
  const path = keyPath(userDataPath);
  try {
    const key = validateKey(readFileSync(path));
    chmodSync(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Viron 本机密钥文件不存在");
    throw error;
  }
}

function readOrCreateKey(userDataPath: string): Buffer {
  try {
    return readKey(userDataPath);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Viron 本机密钥文件不存在") throw error;
  }

  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const path = keyPath(userDataPath);
  const created = randomBytes(LOCAL_SECRET_KEY_BYTES);
  try {
    writeFileSync(path, created, { flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readKey(userDataPath);
  }
}

function aad(context: string): Buffer {
  if (!context) throw new Error("Viron 本机密钥上下文不能为空");
  return Buffer.from(`viron-local-secret\0${context}`, "utf8");
}

export function isLocalSecretCiphertext(value: string | undefined): value is string {
  return Boolean(value?.startsWith(LOCAL_SECRET_PREFIX));
}

export function encryptLocalSecret(userDataPath: string, plaintext: string, context: string): string {
  const iv = randomBytes(LOCAL_SECRET_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", readOrCreateKey(userDataPath), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${LOCAL_SECRET_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export function decryptLocalSecret(userDataPath: string, value: string, context: string): string {
  if (!isLocalSecretCiphertext(value)) throw new Error("Viron 本机密文格式无效");
  const payload = Buffer.from(value.slice(LOCAL_SECRET_PREFIX.length), "base64url");
  if (payload.length < LOCAL_SECRET_IV_BYTES + LOCAL_SECRET_TAG_BYTES) throw new Error("Viron 本机密文内容无效");
  const iv = payload.subarray(0, LOCAL_SECRET_IV_BYTES);
  const tag = payload.subarray(LOCAL_SECRET_IV_BYTES, LOCAL_SECRET_IV_BYTES + LOCAL_SECRET_TAG_BYTES);
  const ciphertext = payload.subarray(LOCAL_SECRET_IV_BYTES + LOCAL_SECRET_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", readKey(userDataPath), iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function localSecretKeyPath(userDataPath: string): string {
  return keyPath(userDataPath);
}
