import type { RedisOptions } from "ioredis";

export interface RedisTlsOptionsInput {
  enabled?: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  certificate?: string;
  privateKey?: string;
  passphrase?: string;
  serverName?: string;
}

export interface RedisOptionsInput {
  host: string;
  port: number;
  username: string;
  password: string;
  database: number;
  connectionName: string;
  connectTimeoutMs?: number;
  tls?: RedisTlsOptionsInput;
  tlsServerNameFallback: string;
}

export function buildRedisOptions(input: RedisOptionsInput): RedisOptions {
  const tls = input.tls;
  return {
    host: input.host,
    port: input.port,
    username: input.username || undefined,
    password: input.password || undefined,
    db: input.database,
    connectTimeout: input.connectTimeoutMs ?? 10_000,
    commandTimeout: input.connectTimeoutMs ?? 10_000,
    connectionName: input.connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    stringNumbers: true,
    tls: tls?.enabled ? {
      rejectUnauthorized: tls.rejectUnauthorized !== false,
      servername: tls.serverName || input.tlsServerNameFallback,
      ca: tls.ca || undefined,
      cert: tls.certificate || undefined,
      key: tls.privateKey || undefined,
      passphrase: tls.passphrase || undefined,
    } : undefined,
  };
}
