export interface WebPluginEntryRecord {
  id: string;
  environmentId: string;
  url: string;
}

/** Longest same-origin path prefix wins. A site root does not cover other entries on that host. */
export function webEntryUrlScore(entryUrl: string, currentUrl: string): number {
  let entry: URL;
  let current: URL;
  try {
    entry = new URL(entryUrl);
    current = new URL(currentUrl);
  } catch {
    return -1;
  }
  if ((entry.protocol !== "http:" && entry.protocol !== "https:") || entry.origin !== current.origin) return -1;
  const entryPath = entry.pathname.replace(/\/+$/, "") || "/";
  const currentPath = current.pathname.replace(/\/+$/, "") || "/";
  if (entryPath === "/") return currentPath === "/" ? 1 : -1;
  if (currentPath === entryPath || currentPath.startsWith(`${entryPath}/`)) return entryPath.length;
  return -1;
}

/** Prefer the view's own entry when the same address belongs to two environments. Otherwise an ambiguous address stays unknown. */
export function selectWebPluginEntry(
  entries: readonly WebPluginEntryRecord[],
  currentUrl: string,
  preferredEntryId = "",
): WebPluginEntryRecord | null {
  let best = -1;
  const scored: Array<{ entry: WebPluginEntryRecord; score: number }> = [];
  for (const entry of entries) {
    const score = webEntryUrlScore(entry.url, currentUrl);
    if (score < 0) continue;
    scored.push({ entry, score });
    if (score > best) best = score;
  }
  const candidates = scored.filter((item) => item.score === best).map((item) => item.entry);
  if (!candidates.length) return null;
  const preferred = preferredEntryId ? candidates.find((entry) => entry.id === preferredEntryId) : undefined;
  if (preferred) return preferred;
  return candidates.length === 1 ? candidates[0] : null;
}
