import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentFloatingOverlayLayout } from "../src/client/agent-floating-overlay.js";
import { agentFloatingOverlayInteractionState, type AgentFloatingOverlayState } from "../src/shared/agent-floating-overlay.js";

const viewport = { width: 1200, height: 800 };

describe("AI Agent native overlay layout", () => {
  it("uses one shared floating launcher and no Web toolbar substitute", () => {
    const floatingWindow = readFileSync(new URL("../src/client/components/AgentFloatingWindow.vue", import.meta.url), "utf8");
    const nativeOverlay = readFileSync(new URL("../src/client/components/AgentFloatingOverlay.vue", import.meta.url), "utf8");
    const webBrowser = readFileSync(new URL("../src/client/components/DesktopWebAccountBrowser.vue", import.meta.url), "utf8");
    const desktopMain = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    expect(floatingWindow).not.toContain("desktopWebAgentLauncherVisible");
    expect(floatingWindow).not.toContain("<AgentFloatingLauncher");
    expect(nativeOverlay).toContain('import AgentFloatingLauncher from "./AgentFloatingLauncher.vue"');
    expect(webBrowser).not.toContain("desktop-web-agent-launcher");
    expect(webBrowser).not.toContain("打开 Viron Agent");
    expect(nativeOverlay).toContain("if (!(event.buttons & 1))");
    expect(nativeOverlay).toContain('document.addEventListener("lostpointercapture", finishDrag)');
    expect(nativeOverlay).toContain("state.interactionLayer");
    expect(nativeOverlay).toContain("opacity: 0;");
    expect(desktopMain).toContain("agentLauncherVisualWindow");
    expect(desktopMain).toContain("agentFloatingOverlayInteractionState");
    expect(desktopMain).toContain("interaction.moveAbove(agentLauncherVisualWindow.getMediaSourceId())");
    expect(desktopMain).not.toContain("agentLauncherHitTestTimer");
    expect(desktopMain).not.toContain("screen.getCursorScreenPoint()");
    expect(desktopMain).toContain("focusable: false");
    expect(desktopMain).toContain("!agentLauncherWindow!.isFocusable()");
  });

  it("uses an always-interactive window matching the visible button", () => {
    const state: AgentFloatingOverlayState = {
      bounds: { x: 288, y: 188, width: 288, height: 288 },
      rootOffset: { x: 112, y: 112 },
      open: false,
      running: false,
      dragging: false,
      edgeCollapsed: false,
      snappedEdge: null,
      label: "打开 Viron Agent",
    };
    expect(agentFloatingOverlayInteractionState(state)).toEqual({
      ...state,
      interactionLayer: true,
      bounds: { x: 400, y: 300, width: 64, height: 64 },
      rootOffset: { x: 0, y: 0 },
    });
  });

  it("keeps both visible right-edge controls inside the interaction window", () => {
    const state: AgentFloatingOverlayState = {
      bounds: { x: 1026, y: 188, width: 174, height: 288 },
      rootOffset: { x: 94, y: 112 },
      open: false,
      running: false,
      dragging: false,
      edgeCollapsed: true,
      snappedEdge: "right",
      label: "展开并打开 Viron Agent",
    };
    expect(agentFloatingOverlayInteractionState(state)).toEqual({
      ...state,
      interactionLayer: true,
      bounds: { x: 1138, y: 300, width: 62, height: 64 },
      rootOffset: { x: -18, y: 0 },
    });
  });

  it("keeps the normal launcher and its glow inside the desktop overlay", () => {
    expect(agentFloatingOverlayLayout({ x: 1120, y: 720 }, viewport, null)).toEqual({
      bounds: { x: 1008, y: 608, width: 192, height: 192 },
      rootOffset: { x: 112, y: 112 },
    });
  });

  it("lets an interior launcher glow fade before the transparent window edge", () => {
    expect(agentFloatingOverlayLayout({ x: 400, y: 300 }, viewport, null)).toEqual({
      bounds: { x: 288, y: 188, width: 288, height: 288 },
      rootOffset: { x: 112, y: 112 },
    });
  });

  it("includes the collapsed button and edge toggle on the right", () => {
    expect(agentFloatingOverlayLayout({ x: 1120, y: 300 }, viewport, "right")).toEqual({
      bounds: { x: 1026, y: 188, width: 174, height: 288 },
      rootOffset: { x: 94, y: 112 },
    });
  });

  it("clips a left-collapsed launcher to the desktop viewport", () => {
    expect(agentFloatingOverlayLayout({ x: 16, y: 300 }, viewport, "left")).toEqual({
      bounds: { x: 0, y: 188, width: 174, height: 288 },
      rootOffset: { x: 16, y: 112 },
    });
  });

  it("includes the bottom edge toggle without extending outside the viewport", () => {
    expect(agentFloatingOverlayLayout({ x: 400, y: 720 }, viewport, "bottom")).toEqual({
      bounds: { x: 288, y: 620, width: 288, height: 180 },
      rootOffset: { x: 112, y: 100 },
    });
  });
});
