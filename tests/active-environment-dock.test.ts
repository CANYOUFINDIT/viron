import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import type { ActiveConnectionItem } from "../src/shared/active-connection.js";
import {
  activeEnvironmentDockCardSize,
  activeEnvironmentDockEnvironments,
  activeEnvironmentDockLayoutSnapshot,
  activeEnvironmentDockPanelSize,
  activeEnvironmentDockPointInsideBounds,
  activeEnvironmentDockStateSnapshot,
  activeEnvironmentDockStackAfterNavigation,
  activeEnvironmentDockVisibleEnvironments,
  clampActiveEnvironmentDockPosition,
  snapActiveEnvironmentDockPosition,
} from "../src/shared/active-environment-dock.js";
import { orderEnvironmentWorkspaceConnections } from "../src/client/environment-workspace-previews.js";
import {
  rememberEnvironmentWorkspaceTransition,
  resetEnvironmentWorkspaceTransition,
  takeEnvironmentWorkspaceTransition,
} from "../src/client/environment-workspace-transition.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function connection(overrides: Partial<ActiveConnectionItem>): ActiveConnectionItem {
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    ownerUsername: "operator",
    type: "ssh",
    label: "SSH A",
    resourceId: crypto.randomUUID(),
    originEnvironmentId: "environment-a",
    environmentIds: ["environment-a"],
    environmentNames: ["Environment A"],
    workspaceType: "personal",
    workspaceId: "workspace-a",
    workspaceName: "Personal",
    client: "web",
    executionMode: "server",
    currentExecutionInstance: false,
    createdAt: "2026-08-10T01:00:00.000Z",
    lastActivityAt: "2026-08-10T01:00:00.000Z",
    status: "active",
    traffic: { sentBytesPerSecond: 0, receivedBytesPerSecond: 0, sentBytes: 0, receivedBytes: 0 },
    ...overrides,
  };
}

describe("active environment picture-in-picture", () => {
  it("hands a picture-in-picture origin to the matching workspace only once", () => {
    resetEnvironmentWorkspaceTransition();
    const origin = { x: 980, y: 620, width: 320, height: 180 };
    rememberEnvironmentWorkspaceTransition("environment-a", origin);
    expect(takeEnvironmentWorkspaceTransition("environment-b")).toBeNull();

    rememberEnvironmentWorkspaceTransition("environment-a", origin);
    expect(takeEnvironmentWorkspaceTransition("environment-a")).toEqual(origin);
    expect(takeEnvironmentWorkspaceTransition("environment-a")).toBeNull();
  });

  it("groups current workspace connections by environment and orders recent activity first", () => {
    const items = [
      connection({ id: "ssh-a", lastActivityAt: "2026-08-10T01:00:00.000Z" }),
      connection({ id: "database-a", type: "database", label: "DB A", lastActivityAt: "2026-08-10T03:00:00.000Z" }),
      connection({
        id: "web-b",
        type: "web",
        label: "Console B",
        originEnvironmentId: null,
        environmentIds: ["environment-b"],
        environmentNames: ["Environment B"],
        lastActivityAt: "2026-08-10T02:00:00.000Z",
      }),
      connection({ id: "other-owner", ownerId: "owner-b" }),
      connection({ id: "other-workspace", workspaceId: "workspace-b" }),
      connection({ id: "other-desktop", executionMode: "local", currentExecutionInstance: false, originEnvironmentId: "environment-c" }),
      connection({ id: "global-database", type: "database", originEnvironmentId: null, environmentIds: ["environment-d"], environmentNames: ["Environment D"] }),
    ];

    const environments = activeEnvironmentDockEnvironments(items, {
      ownerId: "owner-a",
      workspaceType: "personal",
      workspaceId: "workspace-a",
      desktop: true,
    });

    expect(environments.map((environment) => environment.id)).toEqual(["environment-a", "environment-b"]);
    expect(environments[0]).toMatchObject({ name: "Environment A", lastActivityAt: "2026-08-10T03:00:00.000Z" });
    expect(environments[0].connections.map((item) => item.id)).toEqual(["database-a", "ssh-a"]);
    expect(environments[1].connections.map((item) => item.id)).toEqual(["web-b"]);
  });

  it("uses a remembered environment only when it still owns the connection", () => {
    const item = connection({
      id: "database-remembered",
      type: "database",
      originEnvironmentId: null,
      environmentIds: ["environment-a", "environment-b"],
      environmentNames: ["Environment A", "Environment B"],
    });
    expect(activeEnvironmentDockEnvironments([item], {
      ownerId: "owner-a",
      workspaceType: "personal",
      workspaceId: "workspace-a",
      desktop: false,
      rememberedEnvironmentIds: { "database-remembered": "environment-b" },
    })).toMatchObject([{ id: "environment-b", name: "Environment B" }]);
    expect(activeEnvironmentDockEnvironments([item], {
      ownerId: "owner-a",
      workspaceType: "personal",
      workspaceId: "workspace-a",
      desktop: false,
      rememberedEnvironmentIds: { "database-remembered": "environment-missing" },
    })).toEqual([]);
  });

  it("keeps simultaneous local desktop connections from different environments", () => {
    const environments = activeEnvironmentDockEnvironments([
      connection({
        id: "desktop-ssh-a",
        executionMode: "local",
        currentExecutionInstance: true,
        originEnvironmentId: "environment-a",
      }),
      connection({
        id: "desktop-web-b",
        type: "web",
        executionMode: "local",
        currentExecutionInstance: true,
        originEnvironmentId: "environment-b",
        environmentIds: ["environment-b"],
        environmentNames: ["Environment B"],
      }),
    ], { ownerId: "owner-a", workspaceType: "personal", workspaceId: "workspace-a", desktop: true });

    expect(environments.map((environment) => environment.id)).toEqual(["environment-a", "environment-b"]);
  });

  it("converts reactive preview frames into an IPC-cloneable state snapshot", () => {
    const preview = reactive({ dataUrl: "data:image/jpeg;base64,AA==", updatedAt: 1 });
    expect(() => structuredClone({ preview })).toThrow();

    const snapshot = activeEnvironmentDockStateSnapshot({
      bounds: { x: 16, y: 16, width: 346, height: 198 },
      card: { width: 320, height: 180 },
      expanded: false,
      growUp: true,
      dragging: false,
      dark: false,
      language: "zh-CN",
      environments: [{
        id: "environment-a",
        name: "Environment A",
        lastActivityAt: "2026-08-10T01:00:00.000Z",
        preview,
        connections: [{
          id: "desktop-ssh-a",
          type: "ssh",
          label: "SSH A",
          resourceId: "resource-a",
          executionMode: "local",
          lastActivityAt: "2026-08-10T01:00:00.000Z",
          status: "active",
        }],
      }],
    });

    expect(() => structuredClone(snapshot)).not.toThrow();
    expect(snapshot?.environments[0]?.preview).toEqual(preview);
  });

  it("keeps layout-only updates free of preview and environment payloads", () => {
    const layout = activeEnvironmentDockLayoutSnapshot({
      bounds: { x: 16, y: 24, width: 346, height: 564 },
      card: { width: 320, height: 180 },
      expanded: true,
      growUp: false,
      dragging: false,
      dark: false,
      language: "zh-CN",
      environments: [{
        id: "environment-a",
        name: "Environment A",
        lastActivityAt: "2026-08-10T01:00:00.000Z",
        preview: { dataUrl: "data:image/jpeg;base64,AA==", updatedAt: 1 },
        connections: [],
      }],
    });

    expect(layout).toEqual({
      bounds: { x: 16, y: 24, width: 346, height: 564 },
      card: { width: 320, height: 180 },
      expanded: true,
      growUp: false,
      dragging: false,
    });
    expect(layout).not.toHaveProperty("environments");
    expect(layout).not.toHaveProperty("dark");
    expect(layout).not.toHaveProperty("language");
  });

  it("keeps the last visited workspace connection first", () => {
    const environment = activeEnvironmentDockEnvironments([
      connection({ id: "ssh-a", type: "ssh", resourceId: "ssh-resource", lastActivityAt: "2026-08-10T03:00:00.000Z" }),
      connection({ id: "database-a", type: "database", resourceId: "database-resource", lastActivityAt: "2026-08-10T02:00:00.000Z" }),
    ], { ownerId: "owner-a", workspaceType: "personal", workspaceId: "workspace-a", desktop: false })[0]!;

    expect(orderEnvironmentWorkspaceConnections(environment.connections, { tab: "database", connectionId: "database-resource" }).map((item) => item.id)).toEqual([
      "database-a",
      "ssh-a",
    ]);
    expect(orderEnvironmentWorkspaceConnections(environment.connections, { tab: "ssh", activeConnectionId: "ssh-a" }).map((item) => item.id)).toEqual([
      "ssh-a",
      "database-a",
    ]);
  });

  it("swaps foreground environments through an ordered overlapping stack", () => {
    let stack = activeEnvironmentDockStackAfterNavigation([], "environment-a", "");
    expect(stack).toEqual(["environment-a"]);
    stack = activeEnvironmentDockStackAfterNavigation(stack, "", "environment-b");
    expect(stack).toEqual(["environment-a"]);
    stack = activeEnvironmentDockStackAfterNavigation(stack, "environment-b", "environment-a");
    expect(stack).toEqual(["environment-b"]);

    const environments = activeEnvironmentDockEnvironments([
      connection({ id: "ssh-a", originEnvironmentId: "environment-a" }),
      connection({ id: "ssh-b", originEnvironmentId: "environment-b", environmentIds: ["environment-b"], environmentNames: ["Environment B"] }),
    ], { ownerId: "owner-a", workspaceType: "personal", workspaceId: "workspace-a", desktop: false });
    expect(activeEnvironmentDockVisibleEnvironments(environments, ["environment-b", "environment-a"], "environment-b").map((item) => item.id)).toEqual(["environment-a"]);
    expect(activeEnvironmentDockVisibleEnvironments(environments, ["environment-b", "environment-missing"], "").map((item) => item.id)).toEqual(["environment-b", "environment-a"]);
  });

  it("keeps collapsed and expanded 16:9 stacks within the viewport and snaps near an edge", () => {
    const environments = activeEnvironmentDockEnvironments([
      connection({ id: "ssh-a", originEnvironmentId: "environment-a" }),
      connection({ id: "database-b", type: "database", originEnvironmentId: "environment-b", environmentIds: ["environment-b"], environmentNames: ["Environment B"] }),
      connection({ id: "redis-c", type: "redis", originEnvironmentId: "environment-c", environmentIds: ["environment-c"], environmentNames: ["Environment C"] }),
    ], { ownerId: "owner-a", workspaceType: "personal", workspaceId: "workspace-a", desktop: false });
    const viewport = { width: 800, height: 600 };
    expect(activeEnvironmentDockCardSize(viewport)).toEqual({ width: 320, height: 180 });
    expect(activeEnvironmentDockPanelSize(false, environments, viewport)).toEqual({ width: 346, height: 208 });
    expect(activeEnvironmentDockPanelSize(true, environments, viewport)).toEqual({ width: 346, height: 564 });
    expect(clampActiveEnvironmentDockPosition({ x: 900, y: -20 }, viewport, true, environments)).toEqual({ x: 438, y: 16 });
    expect(snapActiveEnvironmentDockPosition({ x: 420, y: 20 }, viewport, true, environments)).toEqual({ x: 420, y: 20 });
  });

  it("treats only points inside the native dock bounds as hovered", () => {
    const bounds = { x: 100, y: 200, width: 320, height: 564 };
    expect(activeEnvironmentDockPointInsideBounds({ x: 100, y: 200 }, bounds)).toBe(true);
    expect(activeEnvironmentDockPointInsideBounds({ x: 419, y: 763 }, bounds)).toBe(true);
    expect(activeEnvironmentDockPointInsideBounds({ x: 420, y: 763 }, bounds)).toBe(false);
    expect(activeEnvironmentDockPointInsideBounds({ x: 419, y: 764 }, bounds)).toBe(false);
  });

  it("keeps live workspace surfaces mounted and renders image previews instead of a connection list", () => {
    const app = source("src/client/App.vue");
    const host = source("src/client/components/EnvironmentWorkspaceHost.vue");
    const detail = source("src/client/views/EnvironmentDetailView.vue");
    const card = source("src/client/components/ActiveEnvironmentDockCard.vue");
    const controller = source("src/client/components/ActiveEnvironmentDockWindow.vue");
    const overlay = source("src/client/components/ActiveEnvironmentDockOverlay.vue");
    const overlayPreload = source("src/desktop/active-environment-dock-preload.cts");
    const desktopBrowser = source("src/client/components/DesktopWebAccountBrowser.vue");
    const desktopMain = source("src/desktop/main.ts");
    const transition = source("src/client/environment-workspace-transition.ts");
    const windowsPackage = source("scripts/package-windows.mjs");

    expect(app).toContain("<EnvironmentWorkspaceHost />");
    expect(host).toContain("toJpeg");
    expect(host).toContain("data-environment-preview-source");
    expect(host).toContain("environmentWorkspacePreviews.retainUntil");
    expect(host).toContain("nativePreviewEnvironmentIds");
    expect(host).toContain("captureDesktopRendererPreview");
    expect(host).toContain("captureCurrentWorkspace");
    expect(host).toContain("router.beforeEach");
    expect(host).toContain(".environment-tab-stage");
    expect(host).toContain("visibility: hidden");
    expect(host).not.toContain("captureCursor");
    expect(host).toContain("setNativePreviewFrame");
    expect(host).toContain('@preview-frame="setNativePreviewFrame(environmentId, $event)"');
    expect(host).toContain(":preview=\"environmentId !== currentEnvironmentId\"");
    expect(detail).toContain(":preview=\"preview\"");
    expect(detail).toContain('return pageActive.value && activeTab.value === "web"');
    expect(detail).toContain('await router.replace({ name: "environment", params: { id: environmentId }, query })');
    expect(detail).toContain("previewFrame: [dataUrl: string]");
    expect(detail).toContain("@preview-frame=\"emit('previewFrame', $event)\"");
    expect(card).toContain("active-environment-pip__visual");
    expect(card).toContain("environment.preview.dataUrl");
    expect(card).toContain("translate3d(var(--active-environment-pip-x), var(--active-environment-pip-y), 0)");
    expect(card).toContain("will-change: transform, opacity");
    expect(card).not.toContain("transition: top");
    expect(card).toContain('window.addEventListener("resize", finishCollapseAfterResize)');
    expect(card).not.toContain("collapseTransitionTimer");
    expect(card).toContain("!props.state.expanded && props.state.environments.length > 1");
    expect(card).toContain('@pointerdown="handleDragPointerdown"');
    expect(card).toContain('@pointermove="handleDragPointermove"');
    expect(card).not.toContain("active-environment-pip__drag-handle");
    expect(card).toContain("ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS");
    expect(card).toContain('@mouseenter="expandFromPointer"');
    expect(card).toContain('@mouseleave="collapseAfterPointerLeaves"');
    expect(card).toContain("cancelCollapse()");
    expect(card).toContain("if (!pointerInside && !focusInside) emit(\"collapse\")");
    expect(card).toContain("active-environment-pip__close");
    expect(card).toContain("closeEnvironment");
    expect(card).toContain("is-activating");
    expect(card).toContain("ENVIRONMENT_WORKSPACE_EXIT_MS");
    expect(card).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(card).not.toContain("active-environment-dock__connections");
    expect(controller).toContain("activeEnvironmentDockVisibleEnvironments");
    expect(controller).toContain("environmentWorkspacePreviews.frames");
    expect(controller).toContain("orderEnvironmentWorkspaceConnections");
    expect(controller).toContain("rememberedQuery");
    expect(controller).toContain("rememberEnvironmentWorkspaceTransition");
    expect(controller).toContain("activeEnvironmentDockStateSnapshot");
    expect(controller).toContain("activeEnvironmentDockLayoutSnapshot");
    expect(controller).toContain("updateDesktopActiveEnvironmentDockLayout");
    expect(controller).toContain("watch([visible, environments");
    expect(controller).toContain("void publish();");
    expect(controller).toContain("if (dragging.value)");
    expect(controller).toContain("pendingFullPublish = true");
    expect(controller).toContain("resumePendingPublish()");
    expect(controller).toContain("dragging.value = true");
    expect(controller).toContain("dragging.value = false");
    expect(controller).toContain("Failed to publish active environment picture-in-picture state");
    expect(controller).toContain("closeActiveConnections");
    expect(controller).toContain("hideEnvironmentWorkspaceConnections");
    expect(overlay).toContain("dragAction('drag-start', $event)");
    expect(overlay).toContain("dragAction('drag-move', $event)");
    expect(overlay).toContain("dragAction('drag-end', $event)");
    expect(overlay).toContain("window.screenX + event.clientX");
    expect(overlay).toContain("window.requestAnimationFrame");
    expect(overlay).toContain("flushDragMove()");
    expect(overlay).toContain("vironActiveEnvironmentDock?.drag");
    expect(overlay).toContain("environmentId, origin");
    expect(overlay).toContain("defer-collapse-resize");
    expect(overlay).toContain("onLayout");
    expect(overlayPreload).toContain('ipcRenderer.on("viron:active-environment-dock-layout"');
    expect(overlayPreload).toContain('ipcRenderer.send("viron:active-environment-dock:drag", action)');
    expect(desktopBrowser).toContain("captureDesktopWebView");
    expect(desktopBrowser).toContain("setDesktopWebViewPreviewing");
    expect(desktopBrowser).toContain("props.environmentId");
    expect(desktopBrowser).toContain('emit("previewFrame", frame)');
    expect(desktopBrowser).toContain("schedulePreviewCapture");
    expect(desktopBrowser).toContain("setDesktopWebViewVisible(state.value.id, false)");
    expect(desktopBrowser).toContain("if (props.preview || !props.active");
    expect(desktopBrowser).toContain("if (props.preview) {");
    expect(desktopBrowser).toContain("schedulePreviewCapture(120)");
    expect(desktopBrowser).toContain("await refreshPreviewFrame();");
    expect(desktopBrowser.indexOf("await refreshPreviewFrame();")).toBeLessThan(desktopBrowser.indexOf("await setDesktopWebViewPreviewing(id, previewing)"));
    expect(desktopMain).toContain("captureDesktopWebViewPreview");
    expect(desktopMain).toContain("captureWebContentsPreview");
    expect(desktopMain).toContain("captureDesktopRendererPreview");
    expect(desktopMain).toContain('ipcMain.handle("viron:renderer-preview:capture"');
    expect(desktopMain).toContain("webContents.capturePage()");
    expect(desktopMain).toContain("if (!view.visible) return");
    expect(desktopMain).toContain(".toJPEG(72)");
    expect(desktopMain).not.toContain("x: -16_384");
    expect(desktopMain).toContain("layoutDesktopWebViewPages");
    expect(desktopMain).toContain("if (view.previewing) view.visible = false;");
    expect(desktopMain).toContain("setBackgroundThrottling(!view.previewing)");
    expect(desktopMain).toContain("previewFrameChanged");
    expect(desktopMain).toContain("retainedPreviewPixels");
    expect(desktopMain).toContain("dragPositionDelivered");
    expect(desktopMain).toContain("handleActiveEnvironmentDockDrag");
    expect(desktopMain).toContain('ipcMain.on("viron:active-environment-dock:drag"');
    expect(desktopMain).toContain('ipcMain.handle("viron:active-environment-dock:layout"');
    expect(desktopMain).toContain("publishActiveEnvironmentDockLayout");
    expect(desktopMain).toContain("if (activeEnvironmentDockDrag) return");
    expect(desktopMain).toContain("dockBounds.x - contentBounds.x + action.origin.x");
    expect(desktopMain).toContain("cardDragMovedWindow");
    expect(desktopMain).toContain("closeActionDelivered");
    expect(desktopMain).toContain("closeStateRemoved");
    expect(desktopMain).toContain("画中画关闭后卡片未移除");
    expect(desktopMain).toContain("nativeAboveWebView");
    expect(desktopMain).toContain("passiveHoverFocusStable");
    expect(desktopMain).toContain('app.focus({ steal: true })');
    expect(desktopMain).toContain("hoverIntentStable");
    expect(desktopMain).toContain("nativePointerTrackingStable");
    expect(desktopMain).toContain("collapseAnimationStable");
    expect(desktopMain).toContain("collapseResizeSynchronized");
    expect(desktopMain).toContain("lightweightLayoutStable");
    expect(desktopMain).toContain("updateLayoutFromRenderer");
    expect(desktopMain).toContain("programmaticMoveIgnored");
    expect(desktopMain).toContain("scheduleActiveEnvironmentDockCollapseLayout");
    expect(desktopMain).toContain("ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS + 34");
    expect(desktopMain).toContain("electronScreen.getCursorScreenPoint()");
    expect(desktopMain).not.toContain("scheduleActiveEnvironmentDockPositionSync");
    expect(desktopMain).not.toContain('overlay.on("move"');
    expect(desktopMain).toContain("expandedAligned");
    expect(desktopMain).toContain("focusable: false");
    expect(host).toContain("takeEnvironmentWorkspaceTransition");
    expect(host).toContain("gsap.fromTo(target");
    expect(host).toContain("environmentId !== enteringEnvironmentId");
    expect(host).toContain("prefers-reduced-motion: reduce");
    expect(transition).toContain("ENVIRONMENT_WORKSPACE_ENTER_MS = 280");
    expect(transition).toContain("ENVIRONMENT_WORKSPACE_EXIT_MS = 110");
    expect(windowsPackage).toContain("/dist/desktop/active-environment-dock-preload.cjs");
    expect(windowsPackage).toContain("/dist/desktop-renderer/desktop-active-environment-dock.html");
  });
});
