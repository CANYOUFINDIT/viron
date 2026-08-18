import { detectLanguage, normalizeLanguage, translateMessage, type Language } from "../shared/i18n.js";

let language: Language = "zh-CN";

export function initializeDesktopLanguage(saved: unknown, systemLocale: string): Language {
  language = normalizeLanguage(saved) ?? detectLanguage(systemLocale);
  return language;
}

export function setDesktopLanguage(value: unknown): Language {
  language = normalizeLanguage(value) ?? language;
  return language;
}

export function currentDesktopLanguage(): Language {
  return language;
}

export function translate(key: string, values: readonly unknown[] = []): string {
  return translateMessage(language, key, values);
}
