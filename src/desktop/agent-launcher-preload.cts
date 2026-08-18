import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vironAgentLauncher", {
  onState(listener: (state: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:agent-launcher-state", handler);
    return () => ipcRenderer.off("viron:agent-launcher-state", handler);
  },
  action(action: unknown) {
    return ipcRenderer.invoke("viron:agent-launcher:action", action);
  },
});
