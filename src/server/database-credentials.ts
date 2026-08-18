import type { FastifyInstance } from "fastify";

export interface DatabaseCredentialSecrets {
  [key: string]: string | undefined;
  password?: string;
  httpTunnelUsername?: string;
  httpTunnelPassword?: string;
  tlsCa?: string;
  tlsCertificate?: string;
  tlsPrivateKey?: string;
  tlsPassphrase?: string;
}

type DatabaseOptions = Record<string, unknown> & {
  ssl?: Record<string, unknown>;
};

const tlsOptionToCredential = {
  ca: "tlsCa",
  certificate: "tlsCertificate",
  privateKey: "tlsPrivateKey",
  passphrase: "tlsPassphrase",
} as const;

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return parseRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function normalizeDatabaseStorage(
  optionsInput: Record<string, unknown>,
  credentialInput: DatabaseCredentialSecrets = {},
): { options: DatabaseOptions; credential: DatabaseCredentialSecrets } {
  const options = structuredClone(optionsInput) as DatabaseOptions;
  const ssl = parseRecord(options.ssl);
  const credential = { ...credentialInput };
  for (const [optionKey, credentialKey] of Object.entries(tlsOptionToCredential) as Array<[
    keyof typeof tlsOptionToCredential,
    (typeof tlsOptionToCredential)[keyof typeof tlsOptionToCredential],
  ]>) {
    const value = ssl[optionKey];
    if (typeof value === "string" && value) credential[credentialKey] = value;
    delete ssl[optionKey];
  }
  options.ssl = ssl;
  return { options, credential };
}

export function hydrateDatabaseOptions(
  optionsInput: Record<string, unknown>,
  credential: DatabaseCredentialSecrets,
): DatabaseOptions {
  const options = structuredClone(optionsInput) as DatabaseOptions;
  const ssl = parseRecord(options.ssl);
  options.ssl = {
    ...ssl,
    ca: credential.tlsCa ?? "",
    certificate: credential.tlsCertificate ?? "",
    privateKey: credential.tlsPrivateKey ?? "",
    passphrase: credential.tlsPassphrase ?? "",
  };
  return options;
}

export function databaseCredentialFlags(credential: DatabaseCredentialSecrets): Record<string, boolean> {
  return {
    hasPassword: Boolean(credential.password),
    hasHttpTunnelAuth: Boolean(credential.httpTunnelUsername || credential.httpTunnelPassword),
    hasTlsCa: Boolean(credential.tlsCa),
    hasTlsCertificate: Boolean(credential.tlsCertificate),
    hasTlsPrivateKey: Boolean(credential.tlsPrivateKey),
    hasTlsPassphrase: Boolean(credential.tlsPassphrase),
  };
}

export function decryptDatabaseCredential(app: FastifyInstance, ciphertext: string): DatabaseCredentialSecrets {
  try {
    return parseJsonRecord(app.secrets.decrypt(ciphertext)) as DatabaseCredentialSecrets;
  } catch {
    return {};
  }
}

export async function migrateDatabaseTlsCredentials(app: FastifyInstance): Promise<void> {
  const rows = await app.db.prepare("SELECT id, credential_ciphertext, options_json FROM database_connections").all() as Array<{
    id: string;
    credential_ciphertext: string;
    options_json: string;
  }>;
  const update = app.db.prepare("UPDATE database_connections SET credential_ciphertext = ?, options_json = ? WHERE id = ?");
  await app.db.transaction(async () => {
    for (const row of rows) {
      const options = parseJsonRecord(row.options_json);
      const ssl = parseRecord(options.ssl);
      if (!Object.keys(tlsOptionToCredential).some((key) => Object.hasOwn(ssl, key))) continue;
      const currentCredential = decryptDatabaseCredential(app, row.credential_ciphertext);
      const normalized = normalizeDatabaseStorage(options, currentCredential);
      await update.run(
        app.secrets.encrypt(JSON.stringify(normalized.credential)),
        JSON.stringify(normalized.options),
        row.id,
      );
    }
  })();
}
