import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vironActiveEnvironmentDock", {
  onState(listener: (state: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:active-environment-dock-state", handler);
    return () => ipcRenderer.off("viron:active-environment-dock-state", handler);
  },
  onLayout(listener: (layout: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, layout: unknown) => listener(layout);
    ipcRenderer.on("viron:active-environment-dock-layout", handler);
    return () => ipcRenderer.off("viron:active-environment-dock-layout", handler);
  },
  action(action: unknown) {
    return ipcRenderer.invoke("viron:active-environment-dock:action", action);
  },
  drag(action: unknown) {
    ipcRenderer.send("viron:active-environment-dock:drag", action);
  },
});
