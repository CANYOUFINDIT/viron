import { translate as tr } from "./i18n.js";
import {
  createDecipheriv,
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
  sign,
} from "node:crypto";

export interface DeviceIdentity {
  deviceId: string;
  keyId: string;
  publicKey: string;
  privateKey: string;
}

export interface CredentialEnvelope {
  protected: string;
  encryptedKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface CredentialEnvelopeClaims {
  version: number;
  algorithm: string;
  keyId: string;
  deviceId: string;
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  credentialId: string;
  endpoint: string;
  targetOrigin: string;
  credentialUpdatedAt: string;
  issuedAt: string;
  expiresAt: string;
}

export interface DesktopWebCredential {
  credentialId: string;
  entryId: string;
  entryUrl: string;
  username: string;
  password: string;
  customFields: Record<string, string>;
  credentialUpdatedAt: string;
}

export interface DesktopSshConnection {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey" | "keyboardInteractive";
  credential: {
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
  jumpConnectionId: string | null;
  options: {
    terminalType?: string;
    keepAliveSeconds?: number;
    encoding?: string;
    hostKeySha256?: string;
    loginScriptEnabled?: boolean;
    loginScript?: string;
  };
  connectionUpdatedAt: string;
}

export interface DesktopSshCredential {
  connection: DesktopSshConnection;
  jumpConnection: DesktopSshConnection | null;
}

export interface DesktopDatabaseConnection {
  connectionId: string;
  name: string;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  username: string;
  password: string;
  httpTunnelUsername: string;
  httpTunnelPassword: string;
  defaultDatabase: string;
  connectionMode: "tcp" | "sshTunnel" | "httpTunnel";
  options: {
    charset?: string;
    timezone?: string;
    connectTimeoutMs?: number;
    sshConnectionId?: string | null;
    ssl?: {
      enabled?: boolean;
      rejectUnauthorized?: boolean;
      ca?: string;
      certificate?: string;
      privateKey?: string;
      passphrase?: string;
    };
    httpTunnelUrl?: string;
    httpTunnelRejectUnauthorized?: boolean;
  };
  connectionUpdatedAt: string;
}

export interface DesktopDatabaseCredential {
  connection: DesktopDatabaseConnection;
  sshCredential: DesktopSshCredential | null;
}

export interface DesktopRedisConnection {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  defaultDatabase: number;
  connectionMode: "tcp" | "sshTunnel";
  options: {
    connectTimeoutMs?: number;
    keySeparator?: string;
    readOnly?: boolean;
    sshConnectionId?: string | null;
    tls?: {
      enabled?: boolean;
      rejectUnauthorized?: boolean;
      ca?: string;
      certificate?: string;
      privateKey?: string;
      passphrase?: string;
      serverName?: string;
    };
  };
  connectionUpdatedAt: string;
}

export interface DesktopRedisCredential {
  connection: DesktopRedisConnection;
  sshCredential: DesktopSshCredential | null;
}

export interface SshCredentialEnvelopeClaims {
  version: number;
  algorithm: string;
  keyId: string;
  deviceId: string;
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  connectionId: string;
  endpoint: string;
  targetHost: string;
  targetPort: number;
  connectionUpdatedAt: string;
  jumpConnectionId: string | null;
  jumpConnectionUpdatedAt: string | null;
  issuedAt: string;
  expiresAt: string;
}

export interface DatabaseCredentialEnvelopeClaims {
  version: number;
  algorithm: string;
  keyId: string;
  deviceId: string;
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  connectionId: string;
  endpoint: string;
  targetHost: string;
  targetPort: number;
  connectionUpdatedAt: string;
  connectionMode: "tcp" | "sshTunnel" | "httpTunnel";
  httpTunnelOrigin: string | null;
  sshConnectionId: string | null;
  sshConnectionUpdatedAt: string | null;
  jumpConnectionId: string | null;
  jumpConnectionUpdatedAt: string | null;
  issuedAt: string;
  expiresAt: string;
}

export interface RedisCredentialEnvelopeClaims {
  version: number;
  algorithm: string;
  keyId: string;
  deviceId: string;
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  connectionId: string;
  endpoint: string;
  targetHost: string;
  targetPort: number;
  connectionUpdatedAt: string;
  connectionMode: "tcp" | "sshTunnel";
  sshConnectionId: string | null;
  sshConnectionUpdatedAt: string | null;
  jumpConnectionId: string | null;
  jumpConnectionUpdatedAt: string | null;
  issuedAt: string;
  expiresAt: string;
}

export interface ExpectedEnvelope {
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  credentialId: string;
  endpoint: string;
}

export interface ExpectedSshEnvelope {
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  connectionId: string;
  endpoint: string;
}

export interface ExpectedDatabaseEnvelope {
  requestId: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  connectionId: string;
  endpoint: string;
}

export type ExpectedRedisEnvelope = ExpectedDatabaseEnvelope;

function keyFingerprint(publicKey: string): string {
  const key = createPublicKey(publicKey);
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function createDeviceIdentity(): DeviceIdentity {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    deviceId: randomUUID(),
    keyId: keyFingerprint(keys.publicKey),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

export function validateDeviceIdentity(identity: DeviceIdentity): boolean {
  try {
    return identity.keyId === keyFingerprint(identity.publicKey)
      && createPublicKey(identity.privateKey).export({ type: "spki", format: "pem" }).toString() === identity.publicKey;
  } catch {
    return false;
  }
}

export function solveDeviceChallenge(identity: DeviceIdentity, encryptedChallenge: string): string {
  return privateDecrypt(
    { key: identity.privateKey, oaepHash: "sha256" },
    Buffer.from(encryptedChallenge, "base64url"),
  ).toString("base64url");
}

export function signDeviceReport(identity: DeviceIdentity, protectedPayload: Buffer): string {
  return sign("sha256", protectedPayload, {
    key: identity.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString("base64url");
}

function assertClaim(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readEnvelopeClaims<TClaims>(envelope: CredentialEnvelope): TClaims {
  const protectedBytes = Buffer.from(envelope.protected, "base64url");
  return JSON.parse(protectedBytes.toString("utf8")) as TClaims;
}

function decryptEnvelopeCredential<TCredential>(identity: DeviceIdentity, envelope: CredentialEnvelope): TCredential {
  const protectedBytes = Buffer.from(envelope.protected, "base64url");
  const contentKey = privateDecrypt(
    { key: identity.privateKey, oaepHash: "sha256" },
    Buffer.from(envelope.encryptedKey, "base64url"),
  );
  const decipher = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(protectedBytes);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as TCredential;
}

export function openCredentialEnvelope(
  identity: DeviceIdentity,
  envelope: CredentialEnvelope,
  expected: ExpectedEnvelope,
  now = Date.now(),
): { claims: CredentialEnvelopeClaims; credential: DesktopWebCredential } {
  const claims = readEnvelopeClaims<CredentialEnvelopeClaims>(envelope);
  assertClaim(claims.version === 1 && claims.algorithm === "RSA-OAEP-256+A256GCM", tr("凭据信封协议不受支持"));
  assertClaim(claims.keyId === identity.keyId && claims.deviceId === identity.deviceId, tr("凭据信封不属于当前设备"));
  assertClaim(claims.requestId === expected.requestId, tr("凭据信封请求不匹配"));
  assertClaim(claims.userId === expected.userId, tr("凭据信封用户不匹配"));
  assertClaim(claims.workspaceType === expected.workspaceType && claims.workspaceId === expected.workspaceId, tr("凭据信封工作空间不匹配"));
  assertClaim(claims.credentialId === expected.credentialId, tr("凭据信封资源不匹配"));
  assertClaim(claims.endpoint === expected.endpoint, tr("凭据信封 Endpoint 不匹配"));
  assertClaim(Number.isFinite(Date.parse(claims.issuedAt)) && Number.isFinite(Date.parse(claims.expiresAt)), tr("凭据信封时间无效"));
  assertClaim(Date.parse(claims.issuedAt) <= now + 30_000 && Date.parse(claims.expiresAt) > now, tr("凭据信封已过期或尚未生效"));
  assertClaim(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) <= 60_000, tr("凭据信封有效期过长"));

  const credential = decryptEnvelopeCredential<DesktopWebCredential>(identity, envelope);
  assertClaim(credential.credentialId === claims.credentialId, tr("凭据信封内容资源不匹配"));
  assertClaim(credential.credentialUpdatedAt === claims.credentialUpdatedAt, tr("凭据信封内容版本不匹配"));
  assertClaim(new URL(credential.entryUrl).origin === claims.targetOrigin, tr("凭据信封目标地址不匹配"));
  return { claims, credential };
}

export function openSshCredentialEnvelope(
  identity: DeviceIdentity,
  envelope: CredentialEnvelope,
  expected: ExpectedSshEnvelope,
  now = Date.now(),
): { claims: SshCredentialEnvelopeClaims; credential: DesktopSshCredential } {
  const claims = readEnvelopeClaims<SshCredentialEnvelopeClaims>(envelope);
  assertClaim(claims.version === 1 && claims.algorithm === "RSA-OAEP-256+A256GCM", tr("凭据信封协议不受支持"));
  assertClaim(claims.keyId === identity.keyId && claims.deviceId === identity.deviceId, tr("凭据信封不属于当前设备"));
  assertClaim(claims.requestId === expected.requestId, tr("凭据信封请求不匹配"));
  assertClaim(claims.userId === expected.userId, tr("凭据信封用户不匹配"));
  assertClaim(claims.workspaceType === expected.workspaceType && claims.workspaceId === expected.workspaceId, tr("凭据信封工作空间不匹配"));
  assertClaim(claims.connectionId === expected.connectionId, tr("凭据信封资源不匹配"));
  assertClaim(claims.endpoint === expected.endpoint, tr("凭据信封 Endpoint 不匹配"));
  assertClaim(Number.isFinite(Date.parse(claims.issuedAt)) && Number.isFinite(Date.parse(claims.expiresAt)), tr("凭据信封时间无效"));
  assertClaim(Date.parse(claims.issuedAt) <= now + 30_000 && Date.parse(claims.expiresAt) > now, tr("凭据信封已过期或尚未生效"));
  assertClaim(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) <= 60_000, tr("凭据信封有效期过长"));
  const credential = decryptEnvelopeCredential<DesktopSshCredential>(identity, envelope);
  assertClaim(credential.connection.connectionId === claims.connectionId, tr("凭据信封内容资源不匹配"));
  assertClaim(credential.connection.connectionUpdatedAt === claims.connectionUpdatedAt, tr("凭据信封内容版本不匹配"));
  assertClaim(credential.connection.host === claims.targetHost && credential.connection.port === claims.targetPort, tr("凭据信封目标地址不匹配"));
  assertClaim((credential.jumpConnection?.connectionId ?? null) === claims.jumpConnectionId, tr("凭据信封跳板机不匹配"));
  assertClaim((credential.jumpConnection?.connectionUpdatedAt ?? null) === claims.jumpConnectionUpdatedAt, tr("凭据信封跳板机版本不匹配"));
  return { claims, credential };
}

export function openDatabaseCredentialEnvelope(
  identity: DeviceIdentity,
  envelope: CredentialEnvelope,
  expected: ExpectedDatabaseEnvelope,
  now = Date.now(),
): { claims: DatabaseCredentialEnvelopeClaims; credential: DesktopDatabaseCredential } {
  const claims = readEnvelopeClaims<DatabaseCredentialEnvelopeClaims>(envelope);
  assertClaim(claims.version === 1 && claims.algorithm === "RSA-OAEP-256+A256GCM", tr("凭据信封协议不受支持"));
  assertClaim(claims.keyId === identity.keyId && claims.deviceId === identity.deviceId, tr("凭据信封不属于当前设备"));
  assertClaim(claims.requestId === expected.requestId, tr("凭据信封请求不匹配"));
  assertClaim(claims.userId === expected.userId, tr("凭据信封用户不匹配"));
  assertClaim(claims.workspaceType === expected.workspaceType && claims.workspaceId === expected.workspaceId, tr("凭据信封工作空间不匹配"));
  assertClaim(claims.connectionId === expected.connectionId, tr("凭据信封资源不匹配"));
  assertClaim(claims.endpoint === expected.endpoint, tr("凭据信封 Endpoint 不匹配"));
  assertClaim(Number.isFinite(Date.parse(claims.issuedAt)) && Number.isFinite(Date.parse(claims.expiresAt)), tr("凭据信封时间无效"));
  assertClaim(Date.parse(claims.issuedAt) <= now + 30_000 && Date.parse(claims.expiresAt) > now, tr("凭据信封已过期或尚未生效"));
  assertClaim(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) <= 60_000, tr("凭据信封有效期过长"));

  const credential = decryptEnvelopeCredential<DesktopDatabaseCredential>(identity, envelope);
  const connection = credential.connection;
  assertClaim(connection.connectionId === claims.connectionId, tr("凭据信封内容资源不匹配"));
  assertClaim(connection.connectionUpdatedAt === claims.connectionUpdatedAt, tr("凭据信封内容版本不匹配"));
  assertClaim(connection.host === claims.targetHost && connection.port === claims.targetPort, tr("凭据信封目标地址不匹配"));
  assertClaim(connection.connectionMode === claims.connectionMode, tr("凭据信封连接模式不匹配"));
  const tunnelOrigin = connection.options.httpTunnelUrl ? new URL(connection.options.httpTunnelUrl).origin : null;
  assertClaim(tunnelOrigin === claims.httpTunnelOrigin, tr("凭据信封 HTTP Tunnel 不匹配"));
  assertClaim((credential.sshCredential?.connection.connectionId ?? null) === claims.sshConnectionId, tr("凭据信封 SSH Tunnel 不匹配"));
  assertClaim((credential.sshCredential?.connection.connectionUpdatedAt ?? null) === claims.sshConnectionUpdatedAt, tr("凭据信封 SSH Tunnel 版本不匹配"));
  assertClaim((credential.sshCredential?.jumpConnection?.connectionId ?? null) === claims.jumpConnectionId, tr("凭据信封跳板机不匹配"));
  assertClaim((credential.sshCredential?.jumpConnection?.connectionUpdatedAt ?? null) === claims.jumpConnectionUpdatedAt, tr("凭据信封跳板机版本不匹配"));
  if (connection.connectionMode === "sshTunnel") assertClaim(Boolean(credential.sshCredential), tr("数据库 SSH Tunnel 凭据缺失"));
  else assertClaim(credential.sshCredential === null, tr("数据库连接包含未声明的 SSH Tunnel 凭据"));
  if (connection.connectionMode === "httpTunnel") assertClaim(Boolean(connection.options.httpTunnelUrl), tr("数据库 HTTP Tunnel 地址缺失"));
  return { claims, credential };
}

export function openRedisCredentialEnvelope(
  identity: DeviceIdentity,
  envelope: CredentialEnvelope,
  expected: ExpectedRedisEnvelope,
  now = Date.now(),
): { claims: RedisCredentialEnvelopeClaims; credential: DesktopRedisCredential } {
  const claims = readEnvelopeClaims<RedisCredentialEnvelopeClaims>(envelope);
  assertClaim(claims.version === 1 && claims.algorithm === "RSA-OAEP-256+A256GCM", tr("凭据信封协议不受支持"));
  assertClaim(claims.keyId === identity.keyId && claims.deviceId === identity.deviceId, tr("凭据信封不属于当前设备"));
  assertClaim(claims.requestId === expected.requestId, tr("凭据信封请求不匹配"));
  assertClaim(claims.userId === expected.userId, tr("凭据信封用户不匹配"));
  assertClaim(claims.workspaceType === expected.workspaceType && claims.workspaceId === expected.workspaceId, tr("凭据信封工作空间不匹配"));
  assertClaim(claims.connectionId === expected.connectionId, tr("凭据信封资源不匹配"));
  assertClaim(claims.endpoint === expected.endpoint, tr("凭据信封 Endpoint 不匹配"));
  assertClaim(Number.isFinite(Date.parse(claims.issuedAt)) && Number.isFinite(Date.parse(claims.expiresAt)), tr("凭据信封时间无效"));
  assertClaim(Date.parse(claims.issuedAt) <= now + 30_000 && Date.parse(claims.expiresAt) > now, tr("凭据信封已过期或尚未生效"));
  assertClaim(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) <= 60_000, tr("凭据信封有效期过长"));

  const credential = decryptEnvelopeCredential<DesktopRedisCredential>(identity, envelope);
  const connection = credential.connection;
  assertClaim(connection.connectionId === claims.connectionId, tr("凭据信封内容资源不匹配"));
  assertClaim(connection.connectionUpdatedAt === claims.connectionUpdatedAt, tr("凭据信封内容版本不匹配"));
  assertClaim(connection.host === claims.targetHost && connection.port === claims.targetPort, tr("凭据信封目标地址不匹配"));
  assertClaim(connection.connectionMode === claims.connectionMode, tr("凭据信封连接模式不匹配"));
  assertClaim((credential.sshCredential?.connection.connectionId ?? null) === claims.sshConnectionId, tr("凭据信封 SSH Tunnel 不匹配"));
  assertClaim((credential.sshCredential?.connection.connectionUpdatedAt ?? null) === claims.sshConnectionUpdatedAt, tr("凭据信封 SSH Tunnel 版本不匹配"));
  assertClaim((credential.sshCredential?.jumpConnection?.connectionId ?? null) === claims.jumpConnectionId, tr("凭据信封跳板机不匹配"));
  assertClaim((credential.sshCredential?.jumpConnection?.connectionUpdatedAt ?? null) === claims.jumpConnectionUpdatedAt, tr("凭据信封跳板机版本不匹配"));
  if (connection.connectionMode === "sshTunnel") assertClaim(Boolean(credential.sshCredential), tr("Redis SSH Tunnel 凭据缺失"));
  else assertClaim(credential.sshCredential === null, tr("Redis 连接包含未声明的 SSH Tunnel 凭据"));
  return { claims, credential };
}
