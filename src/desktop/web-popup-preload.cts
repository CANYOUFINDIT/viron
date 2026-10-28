import { contextBridge, ipcRenderer } from "electron";
import type { DesktopWebPopupAction, DesktopWebPopupState } from "../shared/web-popup.js";

contextBridge.exposeInMainWorld("vironWebPopup", {
  getState(): Promise<DesktopWebPopupState> {
    return ipcRenderer.invoke("viron:web-popup:get-state");
  },
  onState(listener: (state: DesktopWebPopupState) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopWebPopupState) => listener(state);
    ipcRenderer.on("viron:web-popup:state", handler);
    return () => ipcRenderer.off("viron:web-popup:state", handler);
  },
  onFocusAddress(listener: () => void): () => void {
    const handler = () => listener();
    ipcRenderer.on("viron:web-popup-focus-address", handler);
    return () => ipcRenderer.off("viron:web-popup-focus-address", handler);
  },
  action(action: DesktopWebPopupAction): Promise<void> {
    return ipcRenderer.invoke("viron:web-popup:action", action);
  },
});
