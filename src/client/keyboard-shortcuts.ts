import { translate as tr } from "./i18n";
import { shallowRef } from "vue";
import {
  defaultShortcutBindings,
  effectiveShortcutBindings,
  formatShortcutBinding,
  shortcutActionForInput,
  type ShortcutActionId,
  type ShortcutBindings,
  type ShortcutInput,
  type ShortcutOverrides,
} from "../shared/keyboard-shortcuts";
import { isDesktopApp } from "./desktop";

export const APP_SHORTCUT_EVENT = "viron:shortcut";
export const shortcutBindings = shallowRef<ShortcutBindings>(defaultShortcutBindings());

const platform = /Macintosh|Mac OS X/.test(navigator.userAgent) ? "darwin" : "win32";
let initializationPromise: Promise<ShortcutBindings> | undefined;
let desktopListenerRegistered = false;
let initialized = false;

function dispatchShortcut(action: ShortcutActionId) {
  window.dispatchEvent(new CustomEvent(APP_SHORTCUT_EVENT, { detail: { action } }));
}

export async function initializeAppShortcuts(): Promise<ShortcutBindings> {
  if (!isDesktopApp()) return shortcutBindings.value;
  if (!desktopListenerRegistered) {
    window.vironDesktop?.onShortcut(dispatchShortcut);
    desktopListenerRegistered = true;
  }
  if (initialized) return shortcutBindings.value;
  if (!initializationPromise) {
    initializationPromise = window.vironDesktop?.getShortcutPreferences()
      .then((response) => {
        shortcutBindings.value = response.bindings;
        initialized = true;
        initializationPromise = undefined;
        return shortcutBindings.value;
      })
      .catch((error) => {
        initializationPromise = undefined;
        throw error;
      }) ?? Promise.resolve(shortcutBindings.value);
  }
  return initializationPromise;
}

export async function saveAppShortcutOverrides(overrides: ShortcutOverrides): Promise<ShortcutBindings> {
  if (!window.vironDesktop) throw new Error(tr("快捷键设置仅适用于 Viron 桌面 App"));
  const response = await window.vironDesktop.setShortcutPreferences(overrides);
  shortcutBindings.value = response.bindings;
  return response.bindings;
}

export async function setShortcutCapture(active: boolean): Promise<void> {
  if (window.vironDesktop) await window.vironDesktop.setShortcutCapture(active);
}

export function shortcutLabel(action: ShortcutActionId): string {
  return formatShortcutBinding(shortcutBindings.value[action], platform);
}

export function shortcutActionFromKeyboardEvent(event: KeyboardEvent): ShortcutActionId | null {
  return shortcutActionForInput(shortcutBindings.value, {
    key: event.key,
    meta: event.metaKey,
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  }, platform);
}

export function onAppShortcut(handler: (action: ShortcutActionId) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<{ action: ShortcutActionId }>).detail.action);
  window.addEventListener(APP_SHORTCUT_EVENT, listener);
  return () => window.removeEventListener(APP_SHORTCUT_EVENT, listener);
}

export function onShortcutCaptureInput(handler: (input: ShortcutInput) => void): () => void {
  return window.vironDesktop?.onShortcutCaptureInput(handler) ?? (() => undefined);
}

export function effectiveLocalShortcutBindings(overrides: ShortcutOverrides): ShortcutBindings {
  return effectiveShortcutBindings(overrides, platform);
}
