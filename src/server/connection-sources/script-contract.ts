import { z } from "zod";

const name = (max: number) => z.string().trim().min(1).max(max);
const tags = z.array(name(40)).max(20).default([]);
const environmentReferenceSchema = z.object({
  group: name(80).nullable().default(null),
  name: name(120),
}).strict();

const databaseCredentialSchema = z.object({
  password: z.string().max(4096).default(""),
  httpTunnelUsername: z.string().max(4096).default(""),
  httpTunnelPassword: z.string().max(4096).default(""),
  tlsCa: z.string().max(128 * 1024).default(""),
  tlsCertificate: z.string().max(128 * 1024).default(""),
  tlsPrivateKey: z.string().max(128 * 1024).default(""),
  tlsPassphrase: z.string().max(4096).default(""),
}).strict().default({
  password: "",
  httpTunnelUsername: "",
  httpTunnelPassword: "",
  tlsCa: "",
  tlsCertificate: "",
  tlsPrivateKey: "",
  tlsPassphrase: "",
});

const databaseOptionsSchema = z.object({
  charset: name(80).default("utf8mb4"),
  timezone: name(80).default("local"),
  connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
  ssl: z.object({
    enabled: z.boolean().default(false),
    rejectUnauthorized: z.boolean().default(true),
    ca: z.string().max(128 * 1024).default(""),
    certificate: z.string().max(128 * 1024).default(""),
    privateKey: z.string().max(128 * 1024).default(""),
    passphrase: z.string().max(4096).default(""),
  }).strict().default({ enabled: false, rejectUnauthorized: true, ca: "", certificate: "", privateKey: "", passphrase: "" }),
  httpTunnelUrl: z.union([z.literal(""), z.string().url().max(2048)]).default(""),
  httpTunnelRejectUnauthorized: z.boolean().default(true),
}).strict().default({
  charset: "utf8mb4",
  timezone: "local",
  connectTimeoutMs: 10000,
  ssl: { enabled: false, rejectUnauthorized: true, ca: "", certificate: "", privateKey: "", passphrase: "" },
  httpTunnelUrl: "",
  httpTunnelRejectUnauthorized: true,
});

const databaseProfileSchema = z.object({
  name: name(160),
  engine: z.enum(["mysql", "mariadb"]),
  host: name(255),
  port: z.number().int().min(1).max(65535),
  username: name(255),
  credential: databaseCredentialSchema,
  defaultDatabase: z.string().trim().max(255).default(""),
  connectionMode: z.enum(["tcp", "sshTunnel", "httpTunnel"]).default("tcp"),
  sshConnection: name(160).nullable().default(null),
  options: databaseOptionsSchema,
}).strict();

export const scriptSyncPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  environmentGroups: z.array(z.object({
    name: name(80),
    description: z.string().trim().max(500).default(""),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1d8a74"),
    sortOrder: z.number().int().min(0).max(1_000_000).default(0),
  }).strict()).max(1000).default([]),
  environments: z.array(z.object({
    group: name(80).nullable().default(null),
    name: name(120),
    shortName: z.string().trim().max(12).default(""),
    description: z.string().trim().max(2000).default(""),
    status: z.enum(["active", "maintenance", "error", "disabled"]).default("active"),
    owner: z.string().trim().max(120).default(""),
    tags,
    sortOrder: z.number().int().min(0).max(1_000_000).default(0),
  }).strict()).max(5000).default([]),
  webEntries: z.array(z.object({
    environment: environmentReferenceSchema,
    name: name(120),
    url: z.string().url().max(2048),
    description: z.string().trim().max(1000).default(""),
    tags,
    sortOrder: z.number().int().min(0).max(1_000_000).default(0),
    credentials: z.array(z.object({
      username: name(256),
      password: z.string().max(4096).default(""),
      note: z.string().trim().max(1000).default(""),
      customFields: z.record(z.string(), z.string()).default({}),
      sortOrder: z.number().int().min(0).max(1_000_000).default(0),
    }).strict()).max(500).default([]),
  }).strict()).max(5000).default([]),
  connectionGroups: z.array(z.object({
    type: z.enum(["ssh", "database", "redis"]),
    path: name(2000),
    sortOrder: z.number().int().min(0).max(1_000_000).default(0),
  }).strict()).max(3000).default([]),
  sshKeys: z.array(z.object({
    name: name(160),
    privateKey: z.string().min(1).max(128 * 1024),
    passphrase: z.string().max(4096).default(""),
  }).strict()).max(1000).default([]),
  sshConnections: z.array(z.object({
    name: name(160),
    environments: z.array(environmentReferenceSchema).max(100).default([]),
    groupPath: z.string().trim().max(2000).default(""),
    host: name(255),
    port: z.number().int().min(1).max(65535).default(22),
    username: name(255),
    authType: z.enum(["password", "privateKey", "keyboardInteractive"]).default("password"),
    keyName: name(160).nullable().default(null),
    jumpConnection: name(160).nullable().default(null),
    credential: z.object({
      password: z.string().max(4096).default(""),
      privateKey: z.string().max(128 * 1024).default(""),
      passphrase: z.string().max(4096).default(""),
    }).strict().default({ password: "", privateKey: "", passphrase: "" }),
    options: z.object({
      terminalType: name(80).default("xterm-256color"),
      keepAliveSeconds: z.number().int().min(0).max(600).default(30),
      encoding: name(40).default("utf-8"),
      hostKeySha256: z.string().trim().max(160).default(""),
      loginScriptEnabled: z.boolean().default(false),
      loginScript: z.string().max(64 * 1024).default(""),
    }).strict().default({ terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" }),
    tags,
  }).strict()).max(10_000).default([]),
  databaseConnections: z.array(z.object({
    name: name(160),
    environments: z.array(environmentReferenceSchema).max(100).default([]),
    groupPath: z.string().trim().max(2000).default(""),
    engine: z.enum(["mysql", "mariadb"]),
    host: name(255),
    port: z.number().int().min(1).max(65535),
    username: name(255),
    credential: databaseCredentialSchema,
    defaultDatabase: z.string().trim().max(255).default(""),
    connectionMode: z.enum(["tcp", "sshTunnel", "httpTunnel"]).default("tcp"),
    sshConnection: name(160).nullable().default(null),
    options: databaseOptionsSchema,
    profiles: z.array(databaseProfileSchema).max(100).default([]),
  }).strict()).max(10_000).default([]),
  redisConnections: z.array(z.object({
    name: name(160),
    environments: z.array(environmentReferenceSchema).max(100).default([]),
    groupPath: z.string().trim().max(2000).default(""),
    host: name(255),
    port: z.number().int().min(1).max(65535).default(6379),
    username: z.string().trim().max(255).default(""),
    credential: z.object({
      password: z.string().max(4096).default(""),
      tlsCa: z.string().max(128 * 1024).default(""),
      tlsCertificate: z.string().max(128 * 1024).default(""),
      tlsPrivateKey: z.string().max(128 * 1024).default(""),
      tlsPassphrase: z.string().max(4096).default(""),
    }).strict().default({ password: "", tlsCa: "", tlsCertificate: "", tlsPrivateKey: "", tlsPassphrase: "" }),
    defaultDatabase: z.number().int().min(0).max(1023).default(0),
    connectionMode: z.enum(["tcp", "sshTunnel"]).default("tcp"),
    sshConnection: name(160).nullable().default(null),
    options: z.object({
      connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
      keySeparator: z.string().max(16).default(":"),
      readOnly: z.boolean().default(false),
      tls: z.object({
        enabled: z.boolean().default(false),
        rejectUnauthorized: z.boolean().default(true),
        serverName: z.string().trim().max(255).default(""),
      }).strict().default({ enabled: false, rejectUnauthorized: true, serverName: "" }),
    }).strict().default({ connectTimeoutMs: 10000, keySeparator: ":", readOnly: false, tls: { enabled: false, rejectUnauthorized: true, serverName: "" } }),
  }).strict()).max(10_000).default([]),
  environmentLogs: z.array(z.object({
    environment: environmentReferenceSchema,
    sshConnection: name(160),
    name: name(255),
    filePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(100),
  }).strict()).max(5000).default([]),
}).strict();

export type ScriptSyncPayload = z.infer<typeof scriptSyncPayloadSchema>;
export type ScriptEnvironmentReference = z.infer<typeof environmentReferenceSchema>;
