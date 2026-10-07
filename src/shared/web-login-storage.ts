/** Inspect persisted values without mistaking the known public identity for a secret. */
export function containsPersistedWebLoginSecret(value: unknown, password: string, username: string, field = ""): boolean {
  if (!password) return false;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, name: string): boolean => {
    if (typeof item === "string") {
      // Only the exact, already-known identity in an explicitly named identity
      // field is exempt. Password fields and unstructured values still fail.
      if (/^(?:user[_-]?name|login[_-]?name|account[_-]?name)$/i.test(name) && item === username) return false;
      if (/^[\[{\"]/.test(item.trim())) {
        try { return visit(JSON.parse(item), name); } catch { /* Inspect non-JSON text below. */ }
      }
      return item.includes(password);
    }
    if (typeof item === "number" || typeof item === "boolean") return String(item).includes(password);
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (ArrayBuffer.isView(item)) return visit(new TextDecoder().decode(item as Uint8Array), name);
    if (item instanceof ArrayBuffer) return visit(new TextDecoder().decode(item), name);
    if (item instanceof Map) return [...item].some(([key, entry]) => visit(key, "") || visit(entry, typeof key === "string" ? key : ""));
    if (item instanceof Set) return [...item].some((entry) => visit(entry, ""));
    return Object.entries(item).some(([key, entry]) => visit(key, "") || visit(entry, key));
  };
  return visit(value, field);
}
