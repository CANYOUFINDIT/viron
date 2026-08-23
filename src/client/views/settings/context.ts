import { inject, provide, type InjectionKey } from "vue";
import type { useSettingsController } from "./use-settings-controller";

export type SettingsContext = ReturnType<typeof useSettingsController>;

const settingsContextKey: InjectionKey<SettingsContext> = Symbol("settings-context");

export function provideSettingsContext(context: SettingsContext): void {
  provide(settingsContextKey, context);
}

export function useSettingsContext(): SettingsContext {
  const context = inject(settingsContextKey);
  if (!context) throw new Error("Settings context is unavailable");
  return context;
}
