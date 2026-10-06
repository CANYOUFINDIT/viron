import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("desktop web overlay continuity", () => {
  it("keeps the live browser guest mounted behind toolbar menus", () => {
    const component = source("src/client/components/DesktopWebAccountBrowser.vue");
    const pageMenu = component.slice(component.indexOf("function togglePageMenu"), component.indexOf("function refillFromMenu"));
    const extensionMenu = component.slice(component.indexOf("async function toggleExtensions"), component.indexOf("async function changeExtension"));

    expect(pageMenu).not.toContain("captureDesktopWebView");
    expect(pageMenu).not.toContain("setDesktopWebViewVisible");
    expect(extensionMenu).not.toContain("captureDesktopWebView");
    expect(extensionMenu).not.toContain("setDesktopWebViewVisible");
    expect(component).not.toContain("extensionPageHidden");
    expect(component).not.toContain("extensionPageFrame");
    expect(component).not.toContain("target instanceof HTMLElement");
  });

  it("keeps app overlays in the host document instead of adopting their DOM", () => {
    const overlays = source("src/client/native-dom-overlays.ts");
    expect(overlays).not.toContain("appendChild");
    expect(overlays).not.toContain("window.open");
    expect(source("src/client/components/DesktopWebAccountBrowser.vue")).not.toContain("retainAgentNativeOverlay");
  });

  it("does not throttle a live browser page when focus moves to app chrome", () => {
    const runtime = source("src/desktop/web-view-runtime.ts");
    expect(runtime).toContain("const visible = active && !view.login && view.visible && !page.certificateError;");
    expect(runtime).toContain("page.view.webContents.setBackgroundThrottling(!visible && !view.previewing);");
  });
});
