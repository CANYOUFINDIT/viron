import { contextBridge, ipcRenderer } from "electron";

// The service-worker preload runs before `location` is exposed in its isolated world.
if (globalThis.location?.protocol === "chrome-extension:" || !globalThis.location) {
  contextBridge.exposeInMainWorld("__vironExtensionMenus", {
    mutate: (operation: string, extensionId: string, value?: unknown) => ipcRenderer.invoke("viron:extension-menu:mutate", operation, extensionId, value) as Promise<{ error?: string }>,
    activeTabId: () => ipcRenderer.invoke("viron:web-extension:active-tab") as Promise<number | null>,
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
      }; sync?: unknown }; contextMenus?: unknown; tabs?: {
        query?: (queryInfo: Record<string, unknown>, callback?: (tabs: Array<{ id: number; url?: string; active?: boolean }>) => void) => Promise<Array<{ id: number; url?: string; active?: boolean }>>;
      } };
      browser?: { contextMenus?: unknown };
      __vironExtensionMenus?: { mutate: (operation: string, id: string, value?: unknown) => Promise<{ error?: string }>; activeTabId: () => Promise<number | null> };
    };
    const chrome = root.chrome;
    if (globalThis.location?.protocol !== "chrome-extension:" || !chrome?.runtime?.id) return;
    if (chrome.storage?.local) {
      try { Object.defineProperty(chrome.storage, "sync", { configurable: true, value: chrome.storage.local }); }
      catch { /* A future Electron version may provide this storage area itself. */ }
    }
    if (chrome.tabs?.query) {
      const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
      try {
        chrome.tabs.query = (queryInfo, callback) => {
          if (queryInfo?.active !== true) return nativeQuery(queryInfo, callback);
          const result = nativeQuery({}).then(async (tabs) => {
            let activeTabId: number | null = null;
            try { activeTabId = await root.__vironExtensionMenus?.activeTabId() ?? null; }
            catch { /* Background workers may query before a popup is open. */ }
            const webPages = tabs.filter((tab) => /^https?:\/\//i.test(tab.url ?? ""));
            const active = tabs.find((tab) => tab.id === activeTabId)
              ?? webPages.find((tab) => tab.active) ?? webPages.at(-1);
            return active ? [{ ...active, active: true }] : [];
          });
          if (callback) void result.then(callback);
          return result;
        };
      } catch { /* Keep Electron's native implementation if the API is immutable. */ }
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
    // Chrome reports callback errors through runtime.lastError; Promise callers
    // receive a rejection. Extensions use this to fall back from update to create.
    const mutate = (operation: string, value?: unknown, callback?: () => void): Promise<void> | undefined => {
      const result = bridge.mutate(operation, chrome.runtime!.id!, value).then((reply) => {
        if (reply.error) throw new Error(reply.error);
      });
      if (!callback) return result;
      void result.then(callback, (error: Error) => {
        const runtime = chrome.runtime!;
        const previous = Object.getOwnPropertyDescriptor(runtime, "lastError");
        try {
          Object.defineProperty(runtime, "lastError", { configurable: true, value: { message: error.message } });
          callback();
        } finally {
          if (previous) Object.defineProperty(runtime, "lastError", previous);
          else Reflect.deleteProperty(runtime, "lastError");
        }
      });
      return undefined;
    };
    Object.defineProperty(chrome, "contextMenus", { configurable: true, enumerable: true, value: {
      create: (properties: Record<string, unknown>, callback?: () => void) => {
        const id = properties.id ?? `viron-${++nextId}`;
        if (typeof properties.onclick === "function") itemCallbacks.set(id as string | number, properties.onclick as (info: unknown, tab: unknown) => void);
        const result = mutate("create", { ...properties, id, onclick: undefined }, callback);
        if (result) void result.catch((error: Error) => console.error(error.message));
        return id;
      },
      update: (id: string | number, properties: Record<string, unknown>, callback?: () => void) => {
        if (typeof properties.onclick === "function") itemCallbacks.set(id, properties.onclick as (info: unknown, tab: unknown) => void);
        return mutate("update", { ...properties, id, onclick: undefined }, callback);
      },
      remove: (id: string | number, callback?: () => void) => { itemCallbacks.delete(id); return mutate("remove", { id }, callback); },
      removeAll: (callback?: () => void) => { itemCallbacks.clear(); return mutate("removeAll", undefined, callback); },
      onClicked: {
        addListener: (listener: (info: unknown, tab: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (info: unknown, tab: unknown) => void) => listeners.delete(listener),
        hasListener: (listener: (info: unknown, tab: unknown) => void) => listeners.has(listener),
      },
    } });
    // Electron exposes separate chrome/browser namespace objects. Extensions such
    // as Immersive Translate select browser directly, bypassing a Chrome polyfill.
    if (root.browser && !root.browser.contextMenus) {
      Object.defineProperty(root.browser, "contextMenus", { configurable: true, enumerable: true, value: chrome.contextMenus });
    }
  } });
}
