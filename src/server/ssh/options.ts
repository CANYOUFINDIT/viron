export interface SshLoginScriptOptions {
  loginScriptEnabled?: boolean;
  loginScript?: string;
}

export function normalizeSshLoginScript(script: string): string {
  const normalized = script.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function parseOptions(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function preserveSshLoginScript(existingOptionsJson: string, incomingOptions: Record<string, unknown>): Record<string, unknown> {
  const existing = parseOptions(existingOptionsJson) as SshLoginScriptOptions;
  return {
    ...incomingOptions,
    loginScriptEnabled: existing.loginScriptEnabled === true,
    loginScript: typeof existing.loginScript === "string" ? existing.loginScript : "",
  };
}
