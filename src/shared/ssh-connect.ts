import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ConnectConfig } from "ssh2";

export interface SshConnectInput {
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey" | "keyboardInteractive";
  credential: { password?: string; privateKey?: string; passphrase?: string };
  options: { keepAliveSeconds?: number; hostKeySha256?: string };
}

export function sshHostVerifier(expected: string | undefined): ConnectConfig["hostVerifier"] {
  if (!expected) return undefined;
  const normalizedExpected = expected.replace(/^SHA256:/i, "").replace(/=+$/, "");
  return (key: Buffer) => {
    const actual = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
    return actual === normalizedExpected;
  };
}

export function buildSshConnectConfig(
  connection: SshConnectInput,
  sock: Readable | undefined,
  translate: (key: string) => string = (key) => key,
): ConnectConfig {
  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    readyTimeout: 15_000,
    keepaliveInterval: Math.max(0, Number(connection.options.keepAliveSeconds ?? 30)) * 1000,
    keepaliveCountMax: 3,
    hostVerifier: sshHostVerifier(connection.options.hostKeySha256),
    sock,
  };
  if (connection.authType === "privateKey") {
    if (!connection.credential.privateKey) throw new Error(translate("该连接没有保存私钥"));
    config.privateKey = connection.credential.privateKey;
    if (connection.credential.passphrase) config.passphrase = connection.credential.passphrase;
  } else {
    if (!connection.credential.password) throw new Error(translate("该连接没有保存密码"));
    config.password = connection.credential.password;
    if (connection.authType === "keyboardInteractive") config.tryKeyboard = true;
  }
  return config;
}
