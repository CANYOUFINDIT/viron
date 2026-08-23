import { randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView } from "electron";
import { translate as tr } from "../i18n.js";
import type { ImmersiveNavigationState } from "../../shared/immersive-navigation.js";
import {
  agentFloatingOverlayInteractionState,
  type AgentFloatingOverlayState,
} from "../../shared/agent-floating-overlay.js";
import {
  CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT,
  CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
  CONNECTION_QUALITY_PANEL_WIDTH,
  type ConnectionQualityOverlayState,
} from "../../shared/connection-quality.js";
import { mainWindow } from "../window-host.js";
import {
  immersiveNavigationViewport,
  immersiveNavigationWindow,
  updateImmersiveNavigationWindow,
} from "../overlays/immersive-navigation-window.js";
import {
  agentLauncherVisualWindow,
  agentLauncherWindow,
  updateAgentLauncherWindow,
} from "../overlays/agent-launcher-window.js";
import {
  connectionQualityVisualWindow,
  connectionQualityWindow,
  updateConnectionQualityWindow,
} from "../overlays/connection-quality-window.js";

export async function waitForDesktopWindowSnapshot(window: BrowserWindow, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!(await window.webContents.capturePage()).isEmpty()) return true;
    } catch {
      // Chromium's compositor may not have a surface immediately after a transparent child window is shown.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function runDesktopImmersiveNavigationSmoke(): Promise<{
  rendered: boolean;
  snapshot: boolean;
  webViewStayedVisible: boolean;
  snappedTop: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  testView.setBounds({ x: 120, y: 120, width: 420, height: 280 });
  testView.setVisible(true);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL("data:text/html,<main style='background:white'>IMMERSIVE-WEB-VIEW</main>");
  const base: ImmersiveNavigationState = {
    visible: true,
    expanded: false,
    dark: false,
    dock: { edge: "right", offset: 0.5 },
    environmentName: tr("沉浸导航烟测环境"),
    activeTab: "web",
    webExpanded: true,
    expandedEntryId: "entry-smoke",
    selectedEntryId: "entry-smoke",
    selectedCredentialId: "credential-smoke",
    counts: { web: 1, ssh: 2, logs: 3, database: 4, redis: 5, knowledge: 6, maintenance: 0 },
    maintenanceHostCount: 0,
    entries: [{
      id: "entry-smoke",
      name: tr("烟测控制台"),
      credentialCount: 1,
      credentials: [{ id: "credential-smoke", username: "smoke-user" }],
      loading: false,
    }],
  };
  try {
    await updateImmersiveNavigationWindow(base);
    await updateImmersiveNavigationWindow({ ...base, expanded: true });
    const rendered = await immersiveNavigationWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        if (document.body.innerText.includes(${JSON.stringify(tr("沉浸导航烟测环境"))}) && document.body.innerText.includes('smoke-user')) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('沉浸导航未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as boolean;
    const snapshot = await waitForDesktopWindowSnapshot(immersiveNavigationWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    await updateImmersiveNavigationWindow({ ...base, dock: { edge: "top", offset: 0.5 } });
    const topBounds = immersiveNavigationWindow!.getBounds();
    const snappedTop = topBounds.y === immersiveNavigationViewport().y && topBounds.width === 48 && topBounds.height === 34;
    await updateImmersiveNavigationWindow(null);
    return { rendered, snapshot, webViewStayedVisible, snappedTop, hidden: !immersiveNavigationWindow!.isVisible() };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
  }
}

export async function runDesktopAgentLauncherSmoke(): Promise<{
  rendered: boolean;
  exactButtonSize: boolean;
  glowClearance: boolean;
  compactInteraction: boolean;
  nonFocusable: boolean;
  passivePointerStable: boolean;
  snapshot: boolean;
  webViewStayedVisible: boolean;
  actionDelivered: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  testView.setBounds({ x: 240, y: 240, width: 420, height: 280 });
  testView.setVisible(true);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL("data:text/html,<main style='background:white'>AGENT-LAUNCHER-WEB-VIEW</main>");
  const state: AgentFloatingOverlayState = {
    bounds: { x: 280, y: 240, width: 288, height: 288 },
    rootOffset: { x: 112, y: 112 },
    open: false,
    running: false,
    dragging: false,
    edgeCollapsed: false,
    snappedEdge: null,
    label: tr("打开 Viron Agent"),
  };
  try {
    await updateAgentLauncherWindow(state);
    const inspected = await agentLauncherVisualWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const button = document.querySelector('.agent-floating__button');
        if (button) {
          const rect = button.getBoundingClientRect();
          const glowClearance = rect.left >= 110 && rect.top >= 110
            && window.innerWidth - rect.right >= 110 && window.innerHeight - rect.bottom >= 110;
          return resolve({ rendered: button.getAttribute('aria-label') === ${JSON.stringify(tr("打开 Viron Agent"))}, exactButtonSize: rect.width === 64 && rect.height === 64, glowClearance });
        }
        if (Date.now() >= deadline) return reject(new Error('Agent 悬浮按钮未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { rendered: boolean; exactButtonSize: boolean; glowClearance: boolean };
    const actionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      window.__agentLauncherSmokeActions = [];
      const stop = window.vironDesktop.onAgentLauncherAction((action) => {
        window.__agentLauncherSmokeActions.push(action.type);
        if (action.type === 'toggle') { stop(); resolve(true); }
      });
      window.__agentLauncherSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__agentLauncherSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('Agent 悬浮按钮烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    agentLauncherVisualWindow!.webContents.sendInputEvent({ type: "mouseMove", x: 8, y: 8 });
    const passivePointerStable = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      setTimeout(() => resolve(window.__agentLauncherSmokeActions.length === 0), 50);
    })`) as boolean;
    const interactionState = agentFloatingOverlayInteractionState(state);
    const buttonCenter = { x: interactionState.rootOffset.x + 32, y: interactionState.rootOffset.y + 32 };
    agentLauncherWindow!.webContents.sendInputEvent({ type: "mouseMove", ...buttonCenter });
    agentLauncherWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...buttonCenter });
    agentLauncherWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...buttonCenter });
    const actionDelivered = await actionPromise;
    const snapshot = await waitForDesktopWindowSnapshot(agentLauncherVisualWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    const interactionBounds = agentLauncherWindow!.getBounds();
    const compactInteraction = interactionBounds.width === 64 && interactionBounds.height === 64;
    const nonFocusable = !agentLauncherWindow!.isFocusable() && !agentLauncherVisualWindow!.isFocusable();
    await updateAgentLauncherWindow(null);
    return {
      ...inspected,
      compactInteraction,
      nonFocusable,
      passivePointerStable,
      snapshot,
      webViewStayedVisible,
      actionDelivered,
      hidden: !agentLauncherWindow!.isVisible() && !agentLauncherVisualWindow!.isVisible(),
    };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
    await updateAgentLauncherWindow(null);
  }
}

export async function runDesktopConnectionQualitySmoke(): Promise<{
  rendered: boolean;
  exactPanelSize: boolean;
  noHeader: boolean;
  expandedContentFits: boolean;
  testButtonClearance: boolean;
  compactInteraction: boolean;
  nonFocusable: boolean;
  snapshot: boolean;
  webViewStayedVisible: boolean;
  actionDelivered: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  testView.setBounds({ x: 760, y: 100, width: 500, height: 360 });
  testView.setVisible(true);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL("data:text/html,<main style='height:100vh;background:white'>CONNECTION-QUALITY-WEB-VIEW</main>");
  const link = {
    latencyMs: 18,
    jitterMs: 3,
    failureRate: 0,
    status: "good" as const,
    uploadBytesPerSecond: 12_000,
    downloadBytesPerSecond: 48_000,
  };
  const state: ConnectionQualityOverlayState = {
    bounds: { x: 814, y: 44, width: CONNECTION_QUALITY_PANEL_WIDTH + 72, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT + 72 },
    rootOffset: { x: 36, y: 36 },
    panelSize: { width: CONNECTION_QUALITY_PANEL_WIDTH, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT },
    expanded: false,
    dragging: false,
    testing: false,
    service: { id: "service", label: "Viron", detail: "http://127.0.0.1", ...link },
    target: {
      id: randomUUID(), type: "ssh", executionMode: "server", label: tr("烟测目标"), detail: "smoke",
      lastActivityAt: new Date().toISOString(), ...link,
    },
    targets: [],
    speedTest: null,
  };
  state.targets = [state.target!];
  try {
    await updateConnectionQualityWindow(state);
    const inspected = await connectionQualityVisualWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const panel = document.querySelector('[data-connection-quality-card]');
        if (panel) {
          const rect = panel.getBoundingClientRect();
          return resolve({
            rendered: document.body.innerText.includes(${JSON.stringify(tr("烟测目标"))}),
            exactPanelSize: rect.width === ${CONNECTION_QUALITY_PANEL_WIDTH} && rect.height === ${CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT},
            noHeader: !document.querySelector('.connection-quality-card__header'),
          });
        }
        if (Date.now() >= deadline) return reject(new Error('连接质量面板未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { rendered: boolean; exactPanelSize: boolean; noHeader: boolean };
    const actionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const stop = window.vironDesktop.onConnectionQualityAction((action) => {
        if (action.type === 'toggle-details') { stop(); resolve(true); }
      });
      window.__connectionQualitySmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__connectionQualitySmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('连接质量烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const toggle = await connectionQualityWindow!.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-connection-quality-card]');
      const rect = panel.getBoundingClientRect();
      return { x: Math.round(rect.left + 24), y: Math.round(rect.top + 24) };
    })()`) as { x: number; y: number };
    connectionQualityWindow!.webContents.sendInputEvent({ type: "mouseMove", ...toggle });
    connectionQualityWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...toggle });
    connectionQualityWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...toggle });
    const actionDelivered = await actionPromise;
    const compactBounds = connectionQualityWindow!.getBounds();
    const compactInteraction = compactBounds.width === CONNECTION_QUALITY_PANEL_WIDTH
      && compactBounds.height === CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT;
    const expandedState: ConnectionQualityOverlayState = {
      ...state,
      expanded: true,
      bounds: {
        ...state.bounds,
        height: CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT + 72,
      },
      panelSize: {
        width: CONNECTION_QUALITY_PANEL_WIDTH,
        height: CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
      },
    };
    await updateConnectionQualityWindow(expandedState);
    const expandedInspection = await connectionQualityVisualWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const panel = document.querySelector('[data-connection-quality-card]');
        const button = panel?.querySelector('footer button');
        const panelRect = panel?.getBoundingClientRect();
        if (panel && button && Math.round(panelRect.height) === ${CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT}) {
          const buttonRect = button.getBoundingClientRect();
          return resolve({
            expandedContentFits: panel.scrollHeight <= panel.clientHeight,
            testButtonClearance: panelRect.bottom - buttonRect.bottom >= 8,
          });
        }
        if (Date.now() >= deadline) return reject(new Error('连接质量面板展开内容未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { expandedContentFits: boolean; testButtonClearance: boolean };
    const snapshot = await waitForDesktopWindowSnapshot(connectionQualityVisualWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    const nonFocusable = !connectionQualityWindow!.isFocusable() && !connectionQualityVisualWindow!.isFocusable();
    await updateConnectionQualityWindow(null);
    return {
      ...inspected,
      ...expandedInspection,
      compactInteraction,
      nonFocusable,
      snapshot,
      webViewStayedVisible,
      actionDelivered,
      hidden: !connectionQualityWindow!.isVisible() && !connectionQualityVisualWindow!.isVisible(),
    };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
    await updateConnectionQualityWindow(null);
  }
}


