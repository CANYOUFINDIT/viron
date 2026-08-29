import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { desktopWebBoundsAboveOverlay, desktopWebBoundsBesideOverlay, rendererOverlayCoversSurface, type RectangleBounds } from "../src/client/desktop-web-overlay.js";

const surface: RectangleBounds = { left: 224, right: 1440, top: 0, bottom: 900, width: 1216, height: 900 };

function overlay(rect: RectangleBounds, overrides: Partial<Parameters<typeof rendererOverlayCoversSurface>[1]> = {}) {
  return {
    rect,
    ariaHidden: false,
    display: "block",
    visibility: "visible",
    ignored: false,
    ...overrides,
  };
}

describe("desktop Web renderer overlays", () => {
  it("keeps the native Web view beside an Agent panel on the right", () => {
    expect(desktopWebBoundsBesideOverlay(
      surface,
      { left: 1000, right: 1430, top: 180, bottom: 820, width: 430, height: 640 },
    )).toEqual({ left: 224, right: 992, top: 0, bottom: 900, width: 768, height: 900 });
  });

  it("keeps the larger side when the Agent panel opens on the left", () => {
    expect(desktopWebBoundsBesideOverlay(
      surface,
      { left: 230, right: 660, top: 180, bottom: 820, width: 430, height: 640 },
    )).toEqual({ left: 668, right: 1440, top: 0, bottom: 900, width: 772, height: 900 });
  });

  it("keeps full bounds when the Agent panel does not overlap the Web surface", () => {
    expect(desktopWebBoundsBesideOverlay(
      surface,
      { left: 40, right: 180, top: 180, bottom: 820, width: 140, height: 640 },
    )).toEqual(surface);
  });

  it("falls back to hiding when neither side remains usable", () => {
    expect(desktopWebBoundsBesideOverlay(
      { left: 0, right: 420, top: 0, bottom: 700, width: 420, height: 700 },
      { left: 20, right: 400, top: 20, bottom: 680, width: 380, height: 660 },
    )).toBeNull();
  });

  it("keeps the native Web view above the quick composer", () => {
    expect(desktopWebBoundsAboveOverlay(
      surface,
      { left: 420, right: 1180, top: 790, bottom: 875, width: 760, height: 85 },
    )).toEqual({ left: 224, right: 1440, top: 0, bottom: 782, width: 1216, height: 782 });
  });

  it("reserves bottom composer space before right-side bubble space", () => {
    const aboveComposer = desktopWebBoundsAboveOverlay(
      surface,
      { left: 420, right: 1180, top: 790, bottom: 875, width: 760, height: 85 },
    );
    expect(aboveComposer && desktopWebBoundsBesideOverlay(
      aboveComposer,
      { left: 980, right: 1420, top: 560, bottom: 770, width: 440, height: 210 },
    )).toEqual({ left: 224, right: 972, top: 0, bottom: 782, width: 748, height: 782 });
  });

  it("keeps the native Web view full-size and only lifts Agent chrome above it", () => {
    const webBrowser = readFileSync(new URL("../src/client/components/DesktopWebAccountBrowser.vue", import.meta.url), "utf8");
    const appShell = readFileSync(new URL("../src/client/components/AppShell.vue", import.meta.url), "utf8");
    // contract unchanged; implementation moved from src/desktop/main.ts
    const desktopChatOverlay = readFileSync(new URL("../src/desktop/overlays/agent-chat-window.ts", import.meta.url), "utf8");
    expect(webBrowser).not.toContain("desktopWebBoundsAboveOverlay");
    expect(webBrowser).not.toContain("desktopWebBoundsBesideOverlay");
    expect(webBrowser).toContain("retainAgentNativeOverlay");
    expect(webBrowser).toContain("releaseAgentNativeOverlay");
    expect(webBrowser).toContain("elementBounds(surface.value)");
    expect(appShell).toContain("AgentHostBridge");
    expect(appShell).toContain("<AgentFloatingWindow v-if=\"desktop && !agentNativeOverlayActive\" />");
    expect(desktopChatOverlay).toContain("ensureAgentChatWindow");
    expect(desktopChatOverlay).toContain("setAgentChatNativeOverlay");
    expect(desktopChatOverlay).toContain("desktop-agent-chat.html");
  });

  it("freezes a full-page snapshot before hiding the native view under a renderer popover", () => {
    const webBrowser = readFileSync(new URL("../src/client/components/DesktopWebAccountBrowser.vue", import.meta.url), "utf8");
    const desktopWebRuntime = readFileSync(new URL("../src/desktop/web-view-runtime.ts", import.meta.url), "utf8");
    const desktopCoreIpc = readFileSync(new URL("../src/desktop/ipc/register-core-ipc.ts", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8");
    expect(webBrowser).toContain("freezePageForOverlay");
    expect(webBrowser).toContain('captureDesktopWebView(id, "page")');
    expect(webBrowser.indexOf("captureDesktopWebView(id, \"page\")")).toBeLessThan(webBrowser.indexOf("setDesktopWebViewVisible(id, false)"));
    expect(webBrowser).toContain("overlayBlocking && (overlayFrame || previewFrame)");
    expect(webBrowser).toContain("const pendingCapture = captureDesktopWebView(id, \"page\")");
    expect(webBrowser).toContain("is-overlay-frozen");
    expect(webBrowser).toContain(":class=\"{ 'is-preview': preview, 'is-overlay-frozen': overlayBlocking }\"");
    expect(desktopWebRuntime).toContain("export async function captureDesktopWebViewPage");
    expect(desktopWebRuntime).toContain("image.toJPEG(82)");
    expect(desktopCoreIpc).toContain('if (mode === "page") return await captureDesktopWebViewPage(view)');
    expect(preload).toContain("captureWebView: (id: string, mode?: string)");
  });

  it("hides the native page while its cached environment page is deactivated", () => {
    const webBrowser = readFileSync(new URL("../src/client/components/DesktopWebAccountBrowser.vue", import.meta.url), "utf8");
    expect(webBrowser).toContain("onDeactivated(() => {");
    expect(webBrowser).toContain("componentActive = false;");
    expect(webBrowser).toContain("setDesktopWebViewVisible(state.value.id, false)");
    expect(webBrowser).toContain("componentActive && props.active");
    expect(webBrowser).toContain("onActivated(() => {");
    expect(webBrowser).toContain("void nextTick(syncVisibility)");
  });

  it("keeps the native page visible for a menu contained by the sidebar", () => {
    expect(rendererOverlayCoversSurface(
      surface,
      overlay({ left: 78, right: 190, top: 820, bottom: 860, width: 112, height: 40 }),
    )).toBe(false);
  });

  it("hides the native page for a renderer overlay that covers its surface", () => {
    expect(rendererOverlayCoversSurface(
      surface,
      overlay({ left: 190, right: 302, top: 820, bottom: 860, width: 112, height: 40 }),
    )).toBe(true);
  });

  it("ignores the user menu while the sidebar is expanding", () => {
    expect(rendererOverlayCoversSurface(
      surface,
      overlay(
        { left: 190, right: 302, top: 820, bottom: 860, width: 112, height: 40 },
        { ignored: true },
      ),
    )).toBe(false);
  });

  it("ignores hidden renderer overlays", () => {
    const rect = { left: 300, right: 600, top: 200, bottom: 500, width: 300, height: 300 };
    expect(rendererOverlayCoversSurface(surface, overlay(rect, { ariaHidden: true }))).toBe(false);
    expect(rendererOverlayCoversSurface(surface, overlay(rect, { display: "none" }))).toBe(false);
    expect(rendererOverlayCoversSurface(surface, overlay(rect, { visibility: "hidden" }))).toBe(false);
  });
});
