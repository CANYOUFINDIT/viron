import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import ssh2 from "ssh2";

export interface StoredSshCredential {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshKeyReference {
  workspace_type: "personal" | "organization";
  workspace_id: string;
  ssh_key_id: string | null;
  credential_ciphertext: string;
}

export interface ParsedSshPrivateKey {
  algorithm: string;
  publicKey: string;
  fingerprint: string;
}

function parseCredential(app: FastifyInstance, ciphertext: string): StoredSshCredential {
  try {
    return JSON.parse(app.secrets.decrypt(ciphertext)) as StoredSshCredential;
  } catch {
    return {};
  }
}

export function inspectSshPrivateKey(privateKey: string, passphrase = ""): ParsedSshPrivateKey {
  const parsed = ssh2.utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error || !parsed.isPrivateKey()) {
    throw new Error("私钥格式或私钥口令无效");
  }
  const publicBlob = parsed.getPublicSSH();
  return {
    algorithm: parsed.type,
    publicKey: `${parsed.type} ${publicBlob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")}`,
  };
}

export function generateSshKeyPair(
  algorithm: "ed25519" | "rsa3072" | "rsa4096",
  passphrase: string,
  comment: string,
): { privateKey: string; publicKey: string; parsed: ParsedSshPrivateKey } {
  const encryption = passphrase
    ? { passphrase, cipher: "aes256-ctr", rounds: 16 }
    : {};
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pair = algorithm === "ed25519"
      ? ssh2.utils.generateKeyPairSync("ed25519", { comment, ...encryption })
      : ssh2.utils.generateKeyPairSync("rsa", { bits: algorithm === "rsa4096" ? 4096 : 3072, comment, ...encryption });
    try {
      return {
        privateKey: pair.private,
        publicKey: pair.public,
        parsed: inspectSshPrivateKey(pair.private, passphrase),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("生成的 SSH 私钥无法通过格式校验");
}

export async function resolveSshCredential(app: FastifyInstance, reference: SshKeyReference): Promise<StoredSshCredential> {
  const inlineCredential = parseCredential(app, reference.credential_ciphertext);
  if (!reference.ssh_key_id) return inlineCredential;
  const key = await app.db.prepare(`
    SELECT private_key_ciphertext FROM ssh_keys
    WHERE id = ? AND workspace_type = ? AND workspace_id = ?
  `).get(reference.ssh_key_id, reference.workspace_type, reference.workspace_id) as { private_key_ciphertext: string } | undefined;
  if (!key) throw new Error("SSH 连接关联的密钥不存在");
  const keyCredential = parseCredential(app, key.private_key_ciphertext);
  if (!keyCredential.privateKey) throw new Error("SSH 连接关联的密钥没有保存私钥");
  return {
    ...inlineCredential,
    privateKey: keyCredential.privateKey,
    passphrase: keyCredential.passphrase ?? "",
  };
}
