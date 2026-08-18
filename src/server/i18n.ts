import { detectLanguage, localizeUnknownMessage } from "../shared/i18n.js";

const localizedFields = new Set(["message", "reason", "closeReason", "error", "statusText"]);

function localizeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localizeFields);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (localizedFields.has(key) && typeof item === "string") output[key] = localizeUnknownMessage("en", item);
    else output[key] = localizeFields(item);
  }
  return output;
}

export function localizeJsonPayload(acceptLanguage: string | string[] | undefined, payload: string): string {
  const requested = Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage;
  if (!requested) return payload;
  if (detectLanguage(requested) !== "en") return payload;
  try {
    return JSON.stringify(localizeFields(JSON.parse(payload)));
  } catch {
    return payload;
  }
}
