import { BrowserWindow } from "electron";

export let mainWindow: BrowserWindow | null = null;

export function setMainWindow<T extends BrowserWindow | null>(next: T): T {
  mainWindow = next;
  return next;
}
