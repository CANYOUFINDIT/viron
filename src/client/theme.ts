import { ref, watch } from "vue";
import { normalizeTheme, type ThemeName } from "../shared/theme";

export const THEME_STORAGE_KEY = "envman-theme";

function storedTheme(): ThemeName {
  return normalizeTheme(typeof window === "undefined" ? null : window.localStorage.getItem(THEME_STORAGE_KEY));
}

export const theme = ref<ThemeName>(storedTheme());

export function setTheme(value: ThemeName): void {
  theme.value = value;
}

export function consoleUsesLightPalette(value = theme.value): boolean {
  return value === "bright";
}

watch(theme, (value) => {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.documentElement.classList.toggle("dark", value === "dark");
  document.documentElement.classList.toggle("bright", value === "bright");
  document.documentElement.dataset.theme = value;
  window.localStorage.setItem(THEME_STORAGE_KEY, value);
}, { immediate: true });
