import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopTitleBarOverlay,
  isDesktopTitleBarAppearance,
} from "../src/shared/desktop-titlebar.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("desktop title bar theme", () => {
  it("keeps the native controls transparent while matching symbols to each Viron surface", () => {
    expect(desktopTitleBarOverlay("light")).toEqual({ color: "#00000000", symbolColor: "#52656b", height: 36 });
    expect(desktopTitleBarOverlay("bright")).toEqual({ color: "#00000000", symbolColor: "#52656b", height: 36 });
    expect(desktopTitleBarOverlay("dark")).toEqual({ color: "#00000000", symbolColor: "#b8c9c5", height: 36 });
    expect(desktopTitleBarOverlay("login")).toEqual({ color: "#00000000", symbolColor: "#b8c9c5", height: 36 });
  });

  it("accepts only the renderer appearances handled by the main process", () => {
    expect(["light", "dark", "bright", "login"].every(isDesktopTitleBarAppearance)).toBe(true);
    expect(isDesktopTitleBarAppearance("system")).toBe(false);
    expect(isDesktopTitleBarAppearance("#ffffff")).toBe(false);
  });

  it("connects live renderer changes through the isolated preload", () => {
    expect(source("src/client/App.vue")).toContain('setDesktopTitleBarTheme(!routeName || routeName === "login" ? "login" : currentTheme)');
    expect(source("src/desktop/preload.cts")).toContain('ipcRenderer.invoke("viron:titlebar-theme:set", appearance)');
    expect(source("src/desktop/main.ts")).toContain('ipcMain.handle("viron:titlebar-theme:set"');
  });
});
