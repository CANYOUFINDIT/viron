import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vironConnectionQuality", {
  onState(listener: (state: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:connection-quality-state", handler);
    return () => ipcRenderer.off("viron:connection-quality-state", handler);
  },
  action(action: unknown) {
    return ipcRenderer.invoke("viron:connection-quality:action", action);
  },
});
