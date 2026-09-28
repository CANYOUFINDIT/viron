import { contextBridge, ipcRenderer, webFrame } from "electron";

// A separate isolated world per extension keeps temporary activeTab scripts out
// of the page's main world, with only a scoped messaging bridge exposed.
const runtimes = new Map<string, { connected: (value: unknown) => void; message: (value: unknown) => void }>();
ipcRenderer.on("viron:extension-content-connect", (_event, value) => runtimes.get(value.extensionId)?.connected(value));
ipcRenderer.on("viron:extension-content-port", (_event, value) => runtimes.get(value.extensionId)?.message(value));
ipcRenderer.on("viron:extension-script", async (_event, request: { requestId: string; extensionId: string; worldId: number; code: string; mainWorld: boolean }) => {
  try {
    if (!request.mainWorld && !runtimes.has(request.extensionId)) {
      contextBridge.exposeInIsolatedWorld(request.worldId, "__vironContent", {
        id: request.extensionId,
        sendMessage: (message: unknown) => ipcRenderer.invoke("viron:extension-content-message", request.extensionId, message),
        post: (portId: string, message: unknown, disconnect = false) => ipcRenderer.send("viron:extension-content-port", portId, message, disconnect),
        listen: (connected: (value: unknown) => void, message: (value: unknown) => void) => { runtimes.set(request.extensionId, { connected, message }); },
      });
      await webFrame.executeJavaScriptInIsolatedWorld(request.worldId, [{ code: `(${installRuntime.toString()})()` }]);
    }
    const result = await webFrame.executeJavaScriptInIsolatedWorld(request.mainWorld ? 0 : request.worldId, [{ code: request.code }]);
    // Functions/DOM nodes aren't structured-cloneable injection results.
    let serializable: unknown;
    try { serializable = result === undefined ? undefined : JSON.parse(JSON.stringify(result)); } catch { serializable = null; }
    ipcRenderer.send("viron:extension-script-result", request.requestId, serializable);
  } catch (error) { ipcRenderer.send("viron:extension-script-result", request.requestId, undefined, error instanceof Error ? error.message : String(error)); }
});

function installRuntime(): void {
  const root = globalThis as any;
  const bridge = root.__vironContent;
  const event = () => {
    const listeners = new Set<(...args: any[]) => void>();
    return { addListener: (fn: (...args: any[]) => void) => listeners.add(fn), removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn), hasListener: (fn: (...args: any[]) => void) => listeners.has(fn), hasListeners: () => listeners.size > 0, emit: (...args: any[]) => { for (const fn of listeners) fn(...args); } };
  };
  const onConnect = event();
  const ports = new Map<string, any>();
  root.chrome = { runtime: { id: bridge.id, getURL: (path: string) => new URL(path, `chrome-extension://${bridge.id}/`).href, onConnect,
    sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
      const result = bridge.sendMessage(message);
      if (!callback) return result;
      void result.then(callback, (error: Error) => { root.chrome.runtime.lastError = { message: error.message }; try { callback(undefined); } finally { delete root.chrome.runtime.lastError; } });
    },
  } };
  root.browser = root.chrome;
  bridge.listen((details: { portId: string; name: string }) => {
    const port = { name: details.name, sender: { id: bridge.id }, onMessage: event(), onDisconnect: event(),
      postMessage: (message: unknown) => bridge.post(details.portId, message),
      disconnect: () => { ports.delete(details.portId); bridge.post(details.portId, undefined, true); },
    };
    ports.set(details.portId, port);
    onConnect.emit(port);
  }, (details: { portId: string; message: unknown; disconnect?: boolean }) => {
    const port = ports.get(details.portId);
    if (!port) return;
    if (details.disconnect) { ports.delete(details.portId); port.onDisconnect.emit(port); }
    else port.onMessage.emit(details.message, port);
  });
}
