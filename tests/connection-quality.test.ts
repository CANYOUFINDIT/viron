import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendConnectionQualitySample,
  CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT,
  CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
  connectionQualityHealth,
  connectionQualityOverlayInteractionState,
  type ConnectionQualityOverlayState,
} from "../src/shared/connection-quality.js";
import {
  clampConnectionQualityPosition,
  connectionQualityOverlayLayout,
  snapConnectionQualityPosition,
} from "../src/client/connection-quality-layout.js";

const link = {
  id: "service",
  label: "Viron",
  detail: "endpoint",
  latencyMs: 20,
  jitterMs: 2,
  failureRate: 0,
  status: "good" as const,
  uploadBytesPerSecond: 1024,
  downloadBytesPerSecond: 2048,
};

describe("connection quality monitor", () => {
  it("classifies stable, degraded, and unreachable probe windows", () => {
    expect(connectionQualityHealth([
      { at: 1, latencyMs: 20 },
      { at: 2, latencyMs: 24 },
      { at: 3, latencyMs: 22 },
    ])).toMatchObject({ latencyMs: 22, jitterMs: 3, failureRate: 0, status: "good" });
    expect(connectionQualityHealth([
      { at: 1, latencyMs: 120 },
      { at: 2, latencyMs: null },
      { at: 3, latencyMs: 160 },
    ]).status).toBe("poor");
    expect(connectionQualityHealth([{ at: 1, latencyMs: null }]).status).toBe("offline");
    expect(appendConnectionQualitySample(Array.from({ length: 20 }, (_, at) => ({ at, latencyMs: at })), { at: 20, latencyMs: 20 })).toHaveLength(20);
  });

  it("keeps the panel inside the viewport and snaps near an edge", () => {
    const viewport = { width: 1200, height: 800 };
    expect(clampConnectionQualityPosition({ x: 2_000, y: -100 }, viewport, false)).toEqual({ x: 858, y: 16 });
    expect(snapConnectionQualityPosition({ x: 840, y: 210 }, viewport, false)).toEqual({ x: 858, y: 210 });
    expect(connectionQualityOverlayLayout({ x: 858, y: 16 }, viewport, false)).toEqual({
      bounds: { x: 822, y: 0, width: 378, height: 156 },
      rootOffset: { x: 36, y: 16 },
      panelSize: { width: 326, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT },
    });
    expect(connectionQualityOverlayLayout({ x: 858, y: 16 }, viewport, true).panelSize.height).toBe(CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT);
  });

  it("uses a separate exact interaction surface over the padded visual window", () => {
    const state: ConnectionQualityOverlayState = {
      bounds: { x: 100, y: 50, width: 398, height: 176 },
      rootOffset: { x: 36, y: 36 },
      panelSize: { width: 326, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT },
      expanded: false,
      dragging: false,
      testing: false,
      service: link,
      target: null,
      targets: [],
      speedTest: null,
    };
    expect(connectionQualityOverlayInteractionState(state)).toEqual({
      ...state,
      interactionLayer: true,
      bounds: { x: 136, y: 86, width: 326, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT },
      rootOffset: { x: 0, y: 0 },
    });
  });

  it("renders through native visual and interaction windows above embedded Web views", () => {
    const overlay = readFileSync(new URL("../src/client/components/ConnectionQualityOverlay.vue", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../src/client/components/ConnectionQualityWindow.vue", import.meta.url), "utf8");
    const card = readFileSync(new URL("../src/client/components/ConnectionQualityCard.vue", import.meta.url), "utf8");
    const desktopMain = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    // contract unchanged; implementation moved from src/desktop/main.ts
    const desktopOverlay = readFileSync(new URL("../src/desktop/overlays/connection-quality-window.ts", import.meta.url), "utf8");
    expect(controller).toContain("updateDesktopConnectionQuality");
    expect(overlay).toContain("state.interactionLayer");
    expect(overlay).toContain("opacity: 0;");
    expect(desktopOverlay).toContain("connectionQualityVisualWindow");
    expect(desktopOverlay).toContain("interaction.moveAbove(connectionQualityVisualWindow.getMediaSourceId())");
    expect(desktopMain).toContain("runDesktopConnectionQualitySmoke");
    expect(desktopMain).toContain("webViewStayedVisible");
    expect(card).not.toContain("connection-quality-card__header");
    expect(card).toContain("targetIsLocal");
    expect(card).toContain("targetIsLocal ? $t('本机') : 'VIRON'");
    expect(card).toContain("@pointerdown=\"emit('panelPointerdown', $event)\"");
    expect(controller).toContain("suppressClickAfterDrag");
    expect(desktopMain).toContain("testButtonClearance");
  });

  it("is mounted globally but remains opt-in per device", () => {
    const preference = readFileSync(new URL("../src/client/connection-quality-preference.ts", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../src/client/views/SettingsView.vue", import.meta.url), "utf8");
    const appShell = readFileSync(new URL("../src/client/components/AppShell.vue", import.meta.url), "utf8");
    expect(preference).toContain('getItem(CONNECTION_QUALITY_ENABLED_STORAGE_KEY) === "1"');
    expect(settings).toContain("setConnectionQualityEnabled");
    expect(settings).toContain("显示连接质量悬浮面板");
    expect(appShell).toContain("<ConnectionQualityWindow />");
  });
});
