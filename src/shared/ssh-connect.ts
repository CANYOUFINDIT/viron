import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ConnectConfig } from "ssh2";

export type SshAuthType = "password" | "privateKey" | "keyboardInteractive" | "sshAgent";
export type SshProxyType = "none" | "http" | "socks5";
export type SshIpVersion = "auto" | "ipv4" | "ipv6";
export type SshAlgorithmPreset = "default" | "modern" | "compatible";

export interface SshConnectionOptions {
  terminalType?: string;
  keepAliveSeconds?: number;
  encoding?: string;
  hostKeySha256?: string;
  loginScriptEnabled?: boolean;
  loginScript?: string;
  connectTimeoutSeconds?: number;
  ipVersion?: SshIpVersion;
  compression?: boolean;
  agentForwarding?: boolean;
  agentSocket?: string;
  algorithmPreset?: SshAlgorithmPreset;
  proxyType?: SshProxyType;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
}

export interface SshConnectionCredential {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  proxyPassword?: string;
}

export interface SshConnectInput {
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  credential: SshConnectionCredential;
  options: SshConnectionOptions;
}

function agentSocket(connection: SshConnectInput, translate: (key: string) => string): string {
  const configured = connection.options.agentSocket?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return "pageant";
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  throw new Error(translate("未找到 SSH Agent，请配置 Agent Socket"));
}

function algorithmOverrides(preset: SshAlgorithmPreset | undefined, compression: boolean | undefined): ConnectConfig["algorithms"] {
  const algorithms: NonNullable<ConnectConfig["algorithms"]> = {};
  if (preset === "modern") {
    algorithms.kex = { remove: ["diffie-hellman-group1-sha1", "diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1"] } as NonNullable<typeof algorithms.kex>;
    algorithms.cipher = { remove: ["3des-cbc", "aes128-cbc", "aes192-cbc", "aes256-cbc", "arcfour", "arcfour128", "arcfour256"] } as NonNullable<typeof algorithms.cipher>;
    algorithms.serverHostKey = { remove: ["ssh-dss", "ssh-rsa"] } as NonNullable<typeof algorithms.serverHostKey>;
    algorithms.hmac = { remove: ["hmac-md5", "hmac-md5-96", "hmac-sha1-96"] } as NonNullable<typeof algorithms.hmac>;
  } else if (preset === "compatible") {
    algorithms.kex = { append: ["diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1", "diffie-hellman-group1-sha1"] } as NonNullable<typeof algorithms.kex>;
    algorithms.cipher = { append: ["aes256-cbc", "aes192-cbc", "aes128-cbc", "3des-cbc"] } as NonNullable<typeof algorithms.cipher>;
    algorithms.serverHostKey = { append: ["ssh-rsa", "ssh-dss"] } as NonNullable<typeof algorithms.serverHostKey>;
    algorithms.hmac = { append: ["hmac-sha1", "hmac-sha1-96", "hmac-md5"] } as NonNullable<typeof algorithms.hmac>;
  }
  if (compression) algorithms.compress = ["zlib@openssh.com", "zlib", "none"];
  return Object.keys(algorithms).length ? algorithms : undefined;
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
    readyTimeout: Math.max(1, Number(connection.options.connectTimeoutSeconds ?? 15)) * 1000,
    keepaliveInterval: Math.max(0, Number(connection.options.keepAliveSeconds ?? 30)) * 1000,
    keepaliveCountMax: 3,
    hostVerifier: sshHostVerifier(connection.options.hostKeySha256),
    sock,
    forceIPv4: connection.options.ipVersion === "ipv4",
    forceIPv6: connection.options.ipVersion === "ipv6",
    agentForward: Boolean(connection.options.agentForwarding),
    algorithms: algorithmOverrides(connection.options.algorithmPreset, connection.options.compression),
  };
  if (connection.authType === "privateKey") {
    if (!connection.credential.privateKey) throw new Error(translate("该连接没有保存私钥"));
    config.privateKey = connection.credential.privateKey;
    if (connection.credential.passphrase) config.passphrase = connection.credential.passphrase;
  } else if (connection.authType === "sshAgent") {
    config.agent = agentSocket(connection, translate);
    config.authHandler = ["agent"];
  } else {
    if (!connection.credential.password) throw new Error(translate("该连接没有保存密码"));
    config.password = connection.credential.password;
    if (connection.authType === "keyboardInteractive") config.tryKeyboard = true;
  }
  if (connection.options.agentForwarding && !config.agent) config.agent = agentSocket(connection, translate);
  return config;
}
