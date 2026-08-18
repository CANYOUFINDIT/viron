import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vironUpdate", {
  requestCancel: () => ipcRenderer.send("viron:update-window:cancel"),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:update-window:state", handler);
    return () => ipcRenderer.off("viron:update-window:state", handler);
  },
});
