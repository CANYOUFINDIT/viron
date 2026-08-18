import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import {
  defaultImmersiveDock,
  immersiveNavigationEscapeAction,
  immersiveNavigationBounds,
  immersiveNavigationSize,
  plainImmersiveNavigationState,
  snapImmersiveDock,
} from "../src/shared/immersive-navigation.js";

const viewport = { x: 100, y: 80, width: 1200, height: 800 };

describe("environment immersive navigation geometry", () => {
  it("starts collapsed at the middle of the right edge", () => {
    const dock = defaultImmersiveDock();
    const size = immersiveNavigationSize(dock, false, viewport);
    expect(dock).toEqual({ edge: "right", offset: 0.5 });
    expect(immersiveNavigationBounds(dock, size, viewport)).toEqual({ x: 1266, y: 456, width: 34, height: 48 });
  });

  it("keeps an expanded panel inside each supported edge", () => {
    for (const edge of ["left", "right", "top"] as const) {
      const dock = { edge, offset: 0.5 };
      const bounds = immersiveNavigationBounds(dock, immersiveNavigationSize(dock, true, viewport), viewport);
      expect(bounds.x).toBeGreaterThanOrEqual(viewport.x);
      expect(bounds.y).toBeGreaterThanOrEqual(viewport.y);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.x + viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
  });

  it("snaps to left, right, or top but never the bottom edge", () => {
    expect(snapImmersiveDock({ x: 105, y: 400 }, viewport).edge).toBe("left");
    expect(snapImmersiveDock({ x: 1295, y: 400 }, viewport).edge).toBe("right");
    expect(snapImmersiveDock({ x: 700, y: 85 }, viewport).edge).toBe("top");
    expect(snapImmersiveDock({ x: 700, y: 875 }, viewport).edge).toBe("left");
  });

  it("keeps the expanded panel usable in a narrow viewport", () => {
    const narrow = { x: 0, y: 0, width: 220, height: 300 };
    const dock = { edge: "top" as const, offset: 0.5 };
    const size = immersiveNavigationSize(dock, true, narrow);
    const bounds = immersiveNavigationBounds(dock, size, narrow);
    expect(size).toEqual({ width: 196, height: 276 });
    expect(bounds).toEqual({ x: 12, y: 0, width: 196, height: 276 });
  });

  it("converts reactive navigation state into an Electron-cloneable payload", () => {
    const state = reactive({
      visible: true,
      expanded: false,
      dark: false,
      dock: { edge: "right" as const, offset: 0.5 },
      environmentName: "开发环境",
      activeTab: "web" as const,
      webExpanded: true,
      expandedEntryId: "entry-1",
      selectedEntryId: "entry-1",
      selectedCredentialId: "credential-1",
      counts: { web: 1, ssh: 2, logs: 3, database: 4, redis: 5, knowledge: 6, maintenance: 0 },
      maintenanceHostCount: 0,
      entries: [{
        id: "entry-1",
        name: "控制台",
        credentialCount: 1,
        credentials: [{ id: "credential-1", username: "operator" }],
        loading: false,
      }],
    });
    const payload = plainImmersiveNavigationState(state);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual(state);
  });

  it("uses Escape to collapse first and exit second", () => {
    expect(immersiveNavigationEscapeAction({ visible: true, expanded: true })).toEqual({ type: "collapse" });
    expect(immersiveNavigationEscapeAction({ visible: true, expanded: false })).toEqual({ type: "exit" });
    expect(immersiveNavigationEscapeAction(null)).toBeNull();
  });
});
