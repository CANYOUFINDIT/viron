import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vironImmersiveNavigation", {
  onState(listener: (state: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:immersive-navigation-state", handler);
    return () => ipcRenderer.off("viron:immersive-navigation-state", handler);
  },
  action(action: unknown) {
    return ipcRenderer.invoke("viron:immersive-navigation:action", action);
  },
});
