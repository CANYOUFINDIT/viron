import { enMessages } from "./i18n-messages.js";

export const languageNames = ["zh-CN", "en"] as const;
export type Language = (typeof languageNames)[number];

export function normalizeLanguage(value: unknown): Language | null {
  return typeof value === "string" && languageNames.includes(value as Language) ? value as Language : null;
}

export function detectLanguage(locales: readonly string[] | string | null | undefined): Language {
  const values = Array.isArray(locales) ? locales : typeof locales === "string" ? [locales] : [];
  return values[0]?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function formatMessage(template: string, values: readonly unknown[] = []): string {
  return template.replace(/\{\{(\d+)\}\}|\{(\d+)\}/g, (_match, doubleIndex: string | undefined, singleIndex: string | undefined) => String(values[Number(doubleIndex ?? singleIndex)] ?? ""));
}

function canonicalKey(key: string): string {
  return key.replace(/(?<!\{)\{(\d+)\}(?!\})/g, "{{$1}}");
}

const patternedMessages = Object.keys(enMessages)
  .filter((key) => /\{\{\d+\}\}/.test(key))
  .map((key) => {
    const indexes: number[] = [];
    const pattern = key.split(/(\{\{\d+\}\})/g).map((part) => {
      const match = /^\{\{(\d+)\}\}$/.exec(part);
      if (match) {
        indexes.push(Number(match[1]));
        return "([\\s\\S]*?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    return { key, indexes, pattern: new RegExp(`^${pattern}$`) };
  });

export function translateMessage(language: Language, key: string, values: readonly unknown[] = []): string {
  if (language === "zh-CN") return formatMessage(key, values);
  return formatMessage(enMessages[canonicalKey(key)] ?? key, values);
}

export function localizeUnknownMessage(language: Language, source: string): string {
  if (language === "zh-CN" || !source) return source;
  const exact = enMessages[source];
  if (exact) return exact;
  for (const candidate of patternedMessages) {
    const match = candidate.pattern.exec(source);
    if (!match) continue;
    const values: unknown[] = [];
    candidate.indexes.forEach((index, position) => { values[index] = match[position + 1]; });
    return translateMessage(language, candidate.key, values);
  }
  return source;
}
