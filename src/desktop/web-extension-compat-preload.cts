import { contextBridge, ipcRenderer } from "electron";

// The service-worker preload runs before `location` is exposed in its isolated world.
if (globalThis.location?.protocol === "chrome-extension:" || !globalThis.location) {
  contextBridge.exposeInMainWorld("__vironExtensionMenus", {
    mutate: (operation: string, extensionId: string, value?: unknown) => ipcRenderer.invoke("viron:extension-menu:mutate", operation, extensionId, value) as Promise<{ error?: string }>,
    call: (operation: string, args: unknown[]) => ipcRenderer.invoke("viron:extension-browser", operation, args) as Promise<{ result?: unknown; error?: string }>,
    platform: process.platform,
    onPort: (callback: (event: unknown) => void) => ipcRenderer.on("viron:extension-port", (_event, value) => callback(value)),
  });
  contextBridge.executeInMainWorld({ func: () => {
    const root = globalThis as typeof globalThis & {
      chrome?: { runtime?: {
        id?: string;
        getManifest?: () => { commands?: Record<string, { description?: string; suggested_key?: Record<string, string> }> };
        onMessage?: { addListener: (listener: (message: unknown) => void) => void };
        onInstalled?: { addListener: (listener: (details: { reason: string }) => void) => void };
      }; commands?: unknown; storage?: { local?: {
        get: (key: string) => Promise<Record<string, unknown>>;
        set: (items: Record<string, unknown>) => Promise<void>;
      }; sync?: unknown }; contextMenus?: unknown; tabs?: {
        query?: (queryInfo: Record<string, unknown>, callback?: (tabs: Array<{ id: number; url?: string; active?: boolean }>) => void) => Promise<Array<{ id: number; url?: string; active?: boolean }>>;
      } };
      browser?: { contextMenus?: unknown; commands?: unknown };
      __vironExtensionMenus?: { mutate: (operation: string, id: string, value?: unknown) => Promise<{ error?: string }>; call: (operation: string, args: unknown[]) => Promise<{ result?: unknown; error?: string }>; platform: string; onPort: (callback: (event: any) => void) => void };
    };
    const chrome = root.chrome;
    if (globalThis.location?.protocol !== "chrome-extension:" || !chrome?.runtime?.id) return;
    // Keep sender.tab/frameId when a temporary content script relays a message.
    const incoming = chrome.runtime.onMessage as any;
    if (incoming?.addListener) {
      const add = incoming.addListener.bind(incoming);
      const remove = incoming.removeListener?.bind(incoming);
      const has = incoming.hasListener?.bind(incoming);
      const wrapped = new Map<Function, Function>();
      incoming.addListener = (listener: Function) => {
        if (wrapped.has(listener)) return;
        const handler = (message: any, sender: unknown, respond: Function) => message?.__vironContentMessage
          ? listener(message.message, message.sender, respond) : listener(message, sender, respond);
        wrapped.set(listener, handler); add(handler);
      };
      if (remove) incoming.removeListener = (listener: Function) => { remove(wrapped.get(listener) ?? listener); wrapped.delete(listener); };
      if (has) incoming.hasListener = (listener: Function) => has(wrapped.get(listener) ?? listener);
    }
    // Commands are initialized before extension code runs. Registering a listener
    // must work even when the manifest does not declare a default shortcut.
    if (!chrome.commands) {
      const commandListeners = new Set<(name: string, tab: unknown) => void>();
      const commands = {
        getAll: (callback?: (commands: unknown[]) => void) => {
          const list = Object.entries(chrome.runtime?.getManifest?.().commands ?? {}).map(([name, value]) => ({
            name, description: value.description ?? "", shortcut: value.suggested_key?.[root.__vironExtensionMenus?.platform === "darwin" ? "mac" : root.__vironExtensionMenus?.platform === "win32" ? "windows" : "linux"] ?? value.suggested_key?.default ?? "",
          }));
          if (callback) { queueMicrotask(() => callback(list)); return; }
          return Promise.resolve(list);
        },
        onCommand: {
          addListener: (listener: (name: string, tab: unknown) => void) => commandListeners.add(listener),
          removeListener: (listener: (name: string, tab: unknown) => void) => commandListeners.delete(listener),
          hasListener: (listener: (name: string, tab: unknown) => void) => commandListeners.has(listener),
          hasListeners: () => commandListeners.size > 0,
        },
      };
      Object.defineProperty(chrome, "commands", { configurable: true, enumerable: true, value: commands });
      if (root.browser && !root.browser.commands) Object.defineProperty(root.browser, "commands", { configurable: true, enumerable: true, value: commands });
      chrome.runtime.onMessage?.addListener((message) => {
        const event = message as { __vironCommand?: string; extensionId?: string; tab?: unknown } | null;
        if (event?.extensionId === chrome.runtime?.id && typeof event?.__vironCommand === "string") {
          for (const listener of commandListeners) listener(event.__vironCommand, event.tab);
        }
      });
    }
    if (chrome.storage?.local) {
      try { Object.defineProperty(chrome.storage, "sync", { configurable: true, value: chrome.storage.local }); }
      catch { /* A future Electron version may provide this storage area itself. */ }
    }
    const browserBridge = root.__vironExtensionMenus;
    if (browserBridge) {
      const call = (method: string, args: unknown[]) => {
        const callback = typeof args.at(-1) === "function" ? args.pop() as (value?: unknown) => void : undefined;
        const result = browserBridge.call(method, args).then((reply) => {
          if (reply.error) throw new Error(reply.error);
          return reply.result;
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
      };
      const api = chrome as any;
      if (api.scripting?.executeScript && api.tabs?.connect) {
        const nativeExecute = api.scripting.executeScript.bind(api.scripting);
        const nativeConnect = api.tabs.connect.bind(api.tabs);
        const granted = new Set<number>();
        api.tabs.onUpdated?.addListener((tabId: number, changes: { status?: string }) => { if (changes.status === "loading") granted.delete(tabId); });
        const ports = new Map<string, any>();
        const queued = new Map<string, any[]>();
        const deliver = (value: any) => {
          const port = ports.get(value.portId);
          if (!port) { const events = queued.get(value.portId) ?? []; events.push(value); queued.set(value.portId, events); return; }
          if (value.disconnect) { ports.delete(value.portId); port.onDisconnect.emit(port); }
          else port.onMessage.emit(value.message, port);
        };
        browserBridge.onPort(deliver);
        const makeEvent = () => {
          const listeners = new Set<Function>();
          return { addListener: (fn: Function) => listeners.add(fn), removeListener: (fn: Function) => listeners.delete(fn), hasListener: (fn: Function) => listeners.has(fn), hasListeners: () => listeners.size > 0, emit: (...args: unknown[]) => { for (const fn of listeners) fn(...args); } };
        };
        const executeScript = (details: any, callback?: Function) => {
          const result = nativeExecute(details).catch(async (error: Error) => {
            if (!/permission to access|Cannot access contents/i.test(error.message)) throw error;
            const { func, ...properties } = details;
            const reply = await browserBridge.call("scripting.executeScript", [{ ...properties, ...(func ? { functionSource: String(func) } : {}) }]);
            if (reply.error) throw new Error(reply.error);
            granted.add(details.target.tabId);
            return reply.result;
          });
          if (!callback) return result;
          void result.then((value: unknown) => callback(value), (error: Error) => {
            const runtime = chrome.runtime!;
            const previous = Object.getOwnPropertyDescriptor(runtime, "lastError");
            try { Object.defineProperty(runtime, "lastError", { configurable: true, value: { message: error.message } }); callback(); }
            finally { if (previous) Object.defineProperty(runtime, "lastError", previous); else Reflect.deleteProperty(runtime, "lastError"); }
          });
        };
        const connect = (tabId: number, options: any = {}) => {
          if (!granted.has(tabId)) return nativeConnect(tabId, options);
          const ready = browserBridge.call("tabs.connect", [tabId, options]).then((reply) => {
            if (reply.error) throw new Error(reply.error);
            const id = reply.result as string;
            ports.set(id, port);
            for (const message of queued.get(id) ?? []) deliver(message);
            queued.delete(id);
            return id;
          });
          const port = { name: options.name ?? "", onMessage: makeEvent(), onDisconnect: makeEvent(),
            postMessage: (message: unknown) => { void ready.then((id) => call("port.post", [id, message])).catch(() => port.onDisconnect.emit(port)); },
            disconnect: () => { void ready.then((id) => { ports.delete(id); return call("port.disconnect", [id]); }).catch(() => undefined); },
          };
          void ready.catch(() => port.onDisconnect.emit(port));
          return port;
        };
        api.scripting.executeScript = executeScript;
        api.tabs.connect = connect;
        if ((root.browser as any)?.scripting) (root.browser as any).scripting.executeScript = executeScript;
        if ((root.browser as any)?.tabs) (root.browser as any).tabs.connect = connect;
      }
      for (const [namespace, methods] of Object.entries({
        tabs: ["query", "get", "getCurrent", "create", "update", "remove", "captureVisibleTab"],
        windows: ["get", "getCurrent", "getLastFocused", "getAll", "create", "update", "remove"],
      })) {
        for (const target of [chrome, root.browser].filter(Boolean) as Record<string, any>[]) {
          if (!target[namespace]) Object.defineProperty(target, namespace, { configurable: true, enumerable: true, value: {} });
          for (const method of methods) Object.defineProperty(target[namespace], method, { configurable: true, enumerable: true, value: (...args: unknown[]) => call(`${namespace}.${method}`, args) });
          if (namespace === "windows") Object.assign(target[namespace], { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 });
        }
      }
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
