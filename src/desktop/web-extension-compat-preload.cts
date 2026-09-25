import { contextBridge, ipcRenderer } from "electron";

// The service-worker preload runs before `location` is exposed in its isolated world.
if (globalThis.location?.protocol === "chrome-extension:" || !globalThis.location) {
  contextBridge.exposeInMainWorld("__vironExtensionMenus", {
    mutate: (operation: string, extensionId: string, value?: unknown) => ipcRenderer.send("viron:extension-menu:mutate", operation, extensionId, value),
  });
  contextBridge.executeInMainWorld({ func: () => {
    const root = globalThis as typeof globalThis & {
      chrome?: { runtime?: {
        id?: string;
        onMessage?: { addListener: (listener: (message: unknown) => void) => void };
        onInstalled?: { addListener: (listener: (details: { reason: string }) => void) => void };
      }; storage?: { local?: {
        get: (key: string) => Promise<Record<string, unknown>>;
        set: (items: Record<string, unknown>) => Promise<void>;
      }; sync?: unknown }; contextMenus?: unknown };
      __vironExtensionMenus?: { mutate: (operation: string, id: string, value?: unknown) => void };
    };
    const chrome = root.chrome;
    if (globalThis.location?.protocol !== "chrome-extension:" || !chrome?.runtime?.id) return;
    if (chrome.storage?.local) {
      try { Object.defineProperty(chrome.storage, "sync", { configurable: true, value: chrome.storage.local }); }
      catch { /* A future Electron version may provide this storage area itself. */ }
    }
    // Electron loads an unpacked extension without Chrome's first-install event.
    // Deliver it once for this local extension profile so onInstalled menu setup runs.
    const installed = chrome.runtime.onInstalled;
    if (typeof document === "undefined" && installed?.addListener && chrome.storage?.local) {
      const addListener = installed.addListener.bind(installed);
      const listeners: Array<(details: { reason: string }) => void> = [];
      let scheduled = false;
      try {
        installed.addListener = (listener) => {
          addListener(listener);
          listeners.push(listener);
          if (scheduled) return;
          scheduled = true;
          queueMicrotask(async () => {
            const key = "__viron_extension_install_event_v1";
            try {
              const local = chrome.storage!.local!;
              if ((await local.get(key))[key]) return;
              await local.set({ [key]: true });
              for (const callback of listeners) callback({ reason: "install" });
            } catch { /* A failed storage call leaves the native event handler intact. */ }
          });
        };
      } catch { /* A future Electron version may make the event immutable. */ }
    }
    const bridge = root.__vironExtensionMenus;
    if (!bridge) return;
    let nextId = 0;
    const listeners = new Set<(info: unknown, tab: unknown) => void>();
    const itemCallbacks = new Map<string | number, (info: unknown, tab: unknown) => void>();
    chrome.runtime.onMessage?.addListener((message) => {
      if (!message || typeof message !== "object") return;
      const command = message as { __vironMenuClick?: boolean; extensionId?: string; info?: unknown; tab?: unknown };
      if (command.__vironMenuClick && command.extensionId === chrome.runtime?.id) {
        const id = (command.info as { menuItemId?: string | number } | undefined)?.menuItemId;
        if (id !== undefined) itemCallbacks.get(id)?.(command.info, command.tab);
        for (const listener of listeners) listener(command.info, command.tab);
      }
    });
    if (chrome.contextMenus) return;
    Object.defineProperty(chrome, "contextMenus", { configurable: true, value: {
      create: (properties: Record<string, unknown>, callback?: () => void) => {
        const id = properties.id ?? `viron-${++nextId}`;
        if (typeof properties.onclick === "function") itemCallbacks.set(id as string | number, properties.onclick as (info: unknown, tab: unknown) => void);
        bridge.mutate("create", chrome.runtime!.id!, { ...properties, id, onclick: undefined });
        callback?.();
        return id;
      },
      update: (id: string | number, properties: Record<string, unknown>, callback?: () => void) => {
        if (typeof properties.onclick === "function") itemCallbacks.set(id, properties.onclick as (info: unknown, tab: unknown) => void);
        bridge.mutate("update", chrome.runtime!.id!, { id, ...properties, onclick: undefined });
        callback?.();
        return Promise.resolve();
      },
      remove: (id: string | number, callback?: () => void) => { itemCallbacks.delete(id); bridge.mutate("remove", chrome.runtime!.id!, { id }); callback?.(); return Promise.resolve(); },
      removeAll: (callback?: () => void) => { itemCallbacks.clear(); bridge.mutate("removeAll", chrome.runtime!.id!); callback?.(); return Promise.resolve(); },
      onClicked: {
        addListener: (listener: (info: unknown, tab: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (info: unknown, tab: unknown) => void) => listeners.delete(listener),
        hasListener: (listener: (info: unknown, tab: unknown) => void) => listeners.has(listener),
      },
    } });
  } });
}
