import en from "element-plus/es/locale/lang/en";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { computed, ref, watch, type App } from "vue";
import {
  detectLanguage,
  localizeUnknownMessage,
  normalizeLanguage,
  translateMessage,
  type Language,
} from "../shared/i18n";

export const LANGUAGE_STORAGE_KEY = "envman-language";

function initialLanguage(): Language {
  if (typeof window === "undefined") return "zh-CN";
  const stored = normalizeLanguage(window.localStorage?.getItem(LANGUAGE_STORAGE_KEY) ?? null);
  return stored ?? detectLanguage(navigator.languages?.length ? navigator.languages : navigator.language);
}

export const language = ref<Language>(initialLanguage());
export const elementPlusLocale = computed(() => language.value === "zh-CN" ? zhCn : en);

export function currentLocale(): Language {
  return language.value;
}

export function translate(key: string, values: readonly unknown[] = []): string {
  return translateMessage(language.value, key, values);
}

export function localizeMessage(source: string): string {
  return localizeUnknownMessage(language.value, source);
}

export async function setLanguage(value: Language): Promise<void> {
  language.value = value;
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
  await window.vironDesktop?.setLanguage(value);
}

export async function syncDesktopLanguage(): Promise<void> {
  await window.vironDesktop?.setLanguage(language.value);
}

export const i18nPlugin = {
  install(app: App) {
    app.config.globalProperties.$t = translate;
    app.config.globalProperties.$locale = currentLocale;
  },
};

watch(language, (value) => {
  if (typeof document === "undefined") return;
  document.documentElement.lang = value;
  document.documentElement.dataset.language = value;
}, { immediate: true });
