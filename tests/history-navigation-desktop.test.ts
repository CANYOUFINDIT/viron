import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop history navigation wiring", () => {
  it("keeps trackpad history navigation in extracted desktop modules", () => {
    const main = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../src/desktop/history-navigation-runtime.ts", import.meta.url), "utf8");
    const overlay = readFileSync(new URL("../src/desktop/overlays/history-navigation-window.ts", import.meta.url), "utf8");
    const webView = readFileSync(new URL("../src/desktop/web-view-runtime.ts", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8");

    expect(main).toContain("attachDesktopHistoryNavigationListeners(createdMainWindow)");
    expect(main).toContain("closeDesktopHistoryNavigation()");
    expect(main).not.toContain("HISTORY_NAVIGATION_OVERLAY_CSS");
    expect(runtime).toContain("handleDesktopHistoryNavigationWheel");
    expect(runtime).toContain('mainWindow.webContents.send("viron:history-navigation", direction)');
    expect(overlay).toContain("ensureHistoryNavigationOverlay");
    expect(webView).toContain("handleDesktopHistoryNavigationMouse(event, mouse, view, nativeView.webContents)");
    expect(preload).toContain('ipcRenderer.on("viron:history-navigation", handler)');
    expect(preload).toContain('ipcRenderer.on("viron:history-navigation-touch", handler)');
  });
});
