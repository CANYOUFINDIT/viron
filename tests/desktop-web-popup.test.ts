import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("desktop Web popup shell", () => {
  it("hosts page-initiated windows with an address bar above the native page view", () => {
    const runtime = source("../src/desktop/web-popup-window.ts");
    expect(runtime).toContain("createDesktopWebPopupWindow");
    expect(runtime).toContain("new WebContentsView({ webContents: target })");
    expect(runtime).toContain("DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT");
    expect(runtime).toContain('"desktop-web-popup.html"');
    expect(runtime).toContain('"web-popup-preload.cjs"');
    expect(runtime).toContain("normalizeWebAddress");

    const shell = source("../src/client/components/DesktopWebPopupChrome.vue");
    expect(shell).toContain('class="web-popup-address"');
    expect(shell).toContain('{ type: "navigate", url }');

    const viewRuntime = source("../src/desktop/web-view-runtime.ts");
    expect(viewRuntime).toContain("createDesktopWebPopupWindow(targetContents");
    expect(viewRuntime).toContain("contents: WebContents");
  });

  it("keeps the popup shell and preload in the Windows package allowlist", () => {
    const windowsPackage = source("../scripts/package-windows.mjs");
    expect(windowsPackage).toContain("/dist/desktop/web-popup-preload.cjs");
    expect(windowsPackage).toContain("/dist/desktop-renderer/desktop-web-popup.html");
    expect(source("../vite.config.ts")).toContain("desktop-web-popup");
  });
});
