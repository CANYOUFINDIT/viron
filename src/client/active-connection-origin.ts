const storageKey = "viron:active-connection-origins";

function readOrigins(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function rememberActiveConnectionOrigin(activeConnectionId: string, environmentId?: string): void {
  if (!activeConnectionId || !environmentId) return;
  const origins = readOrigins();
  origins[activeConnectionId] = environmentId;
  sessionStorage.setItem(storageKey, JSON.stringify(origins));
}

export function rememberedActiveConnectionOrigin(activeConnectionId: string): string | undefined {
  return readOrigins()[activeConnectionId];
}

export function pruneActiveConnectionOrigins(activeConnectionIds: Iterable<string>): void {
  const activeIds = new Set(activeConnectionIds);
  const origins = readOrigins();
  const retained = Object.fromEntries(Object.entries(origins).filter(([id]) => activeIds.has(id)));
  sessionStorage.setItem(storageKey, JSON.stringify(retained));
}
