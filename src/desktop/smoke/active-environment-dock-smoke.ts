import { randomUUID } from "node:crypto";
import {
  app,
  screen as electronScreen,
  WebContentsView,
  type Rectangle,
} from "electron";
import { currentDesktopLanguage, translate as tr } from "../i18n.js";
import {
  activeEnvironmentDockCardSize,
  activeEnvironmentDockLayoutSnapshot,
  activeEnvironmentDockPanelSize,
  ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS,
  ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS,
  type ActiveEnvironmentDockState,
} from "../../shared/active-environment-dock.js";
import { mainWindow } from "../window-host.js";
import {
  activeEnvironmentDockWindow,
  scheduleActiveEnvironmentDockPointerTracking,
  stopActiveEnvironmentDockPointerTracking,
  updateActiveEnvironmentDockWindow,
} from "../overlays/active-environment-dock-window.js";
import {
  captureDesktopRendererPreview,
  captureWebContentsPreview,
} from "../web-view-runtime.js";
import { desktopSmokeStage } from "./stage.js";
import { waitForDesktopWindowSnapshot } from "./static-overlay-smoke.js";

export async function runDesktopActiveEnvironmentDockSmoke(): Promise<{
  rendered: boolean;
  collapsedPanelSize: boolean;
  expandedPanelSize: boolean;
  collapsedStacked: boolean;
  expandedStacked: boolean;
  expandedAligned: boolean;
  anchorStable: boolean;
  expandedContentFits: boolean;
  rendererPreviewPixels: boolean;
  previewPixels: boolean;
  previewFrameChanged: boolean;
  retainedPreviewPixels: boolean;
  nonInteractivePreview: boolean;
  dragPositionDelivered: boolean;
  closeActionDelivered: boolean;
  closeStateRemoved: boolean;
  snapshot: boolean;
  nonFocusable: boolean;
  passiveHoverFocusStable: boolean;
  hoverIntentStable: boolean;
  nativePointerTrackingStable: boolean;
  collapseAnimationStable: boolean;
  collapseResizeSynchronized: boolean;
  lightweightLayoutStable: boolean;
  programmaticMoveIgnored: boolean;
  webViewStayedVisible: boolean;
  nativeAboveWebView: boolean;
  actionDelivered: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const rendererPreviewBounds = await mainWindow.webContents.executeJavaScript(`(() => {
    const marker = document.createElement('div');
    marker.id = 'active-environment-renderer-preview-smoke';
    marker.style.cssText = 'position:fixed;left:24px;top:24px;width:320px;height:180px;z-index:2147483647;background:#155e75;color:white;display:grid;place-items:center;font:700 28px sans-serif';
    marker.textContent = 'SSH-RENDERER-PREVIEW';
    document.body.appendChild(marker);
    const rect = marker.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`) as Rectangle;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const rendererPreview = await captureDesktopRendererPreview(rendererPreviewBounds);
  await mainWindow.webContents.executeJavaScript("document.querySelector('#active-environment-renderer-preview-smoke')?.remove()", true);
  const rendererPreviewPixels = Boolean(rendererPreview);
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, offscreen: true } });
  const testViewBounds = { x: 180, y: 130, width: 520, height: 360 };
  testView.setBounds(testViewBounds);
  testView.setVisible(true);
  testView.webContents.setBackgroundThrottling(false);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#0d5f52;color:white;font:700 34px sans-serif;display:grid;place-items:center;height:100vh"><main>ACTIVE-ENVIRONMENT-PIP</main><script>let on=false;setInterval(()=>{on=!on;document.body.style.background=on?'#b23a48':'#0d5f52'},90)</script></body></html>`)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  desktopSmokeStage("dock-preview-visible-first");
  const firstPreview = await captureWebContentsPreview(testView.webContents);
  await testView.webContents.executeJavaScript("document.querySelector('main').textContent='ACTIVE-ENVIRONMENT-PIP-UPDATED'; document.body.style.background='#facc15'; document.body.offsetHeight", true);
  desktopSmokeStage("dock-preview-visible-second");
  let secondPreview = "";
  const previewDeadline = Date.now() + 3_000;
  while (Date.now() < previewDeadline && (!secondPreview || secondPreview === firstPreview)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    secondPreview = await captureWebContentsPreview(testView.webContents);
  }
  const previewFrameChanged = Boolean(firstPreview && secondPreview && firstPreview !== secondPreview);
  testView.setVisible(false);
  desktopSmokeStage("dock-preview-retained");
  const retainedPreviewPixels = Boolean(secondPreview);
  testView.setVisible(true);
  const now = Date.now();
  const environments = [
    {
      id: "dock-smoke-environment-a",
      name: "DOCK-SMOKE-ENVIRONMENT-A",
      lastActivityAt: new Date(now).toISOString(),
      preview: { dataUrl: rendererPreview, updatedAt: now },
      connections: [
        { id: "dock-smoke-ssh", type: "ssh" as const, label: "DOCK-SMOKE-SSH", resourceId: randomUUID(), executionMode: "local" as const, lastActivityAt: new Date(now).toISOString(), status: "active" as const },
      ],
    },
    {
      id: "dock-smoke-environment-b",
      name: "DOCK-SMOKE-ENVIRONMENT-B",
      lastActivityAt: new Date(now - 1_000).toISOString(),
      preview: { dataUrl: secondPreview, updatedAt: now },
      connections: [
        { id: "dock-smoke-database", type: "database" as const, label: "DOCK-SMOKE-DATABASE", resourceId: randomUUID(), executionMode: "server" as const, lastActivityAt: new Date(now - 1_000).toISOString(), status: "active" as const },
      ],
    },
  ];
  const contentViewport = mainWindow.getContentBounds();
  const viewport = { width: contentViewport.width, height: contentViewport.height };
  const card = activeEnvironmentDockCardSize(viewport);
  const collapsedSize = activeEnvironmentDockPanelSize(false, environments, viewport);
  const collapsedState: ActiveEnvironmentDockState = {
    bounds: { x: 240, y: 170, ...collapsedSize },
    card,
    expanded: false,
    growUp: false,
    dragging: false,
    dark: false,
    language: currentDesktopLanguage(),
    environments,
  };
  const updateLayoutFromRenderer = async (state: ActiveEnvironmentDockState): Promise<void> => {
    const layout = activeEnvironmentDockLayoutSnapshot(state);
    await mainWindow!.webContents.executeJavaScript(
      `window.vironDesktop.updateActiveEnvironmentDockLayout(${JSON.stringify(layout)})`,
    );
  };
  try {
    await updateActiveEnvironmentDockWindow(collapsedState);
    const collapsedInspection = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const panel = document.querySelector('[data-active-environment-dock]');
        const cards = [...document.querySelectorAll('.active-environment-pip__card')];
        const images = [...document.querySelectorAll('.active-environment-pip__visual img')];
        if (panel && cards.length === 2 && images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)) {
          window.__activeEnvironmentDockLayoutCards = cards;
          window.__activeEnvironmentDockLayoutImages = images;
          const rect = panel.getBoundingClientRect();
          const first = cards[0].getBoundingClientRect();
          const second = cards[1].getBoundingClientRect();
          const visual = document.querySelector('.active-environment-pip__visual');
          return resolve({
            collapsedPanelSize: rect.width === ${collapsedSize.width} && rect.height === ${collapsedSize.height},
            collapsedStacked: second.top > first.top && second.top - first.top <= 12 && Math.abs(second.left - first.left) <= 8,
            firstLeft: first.left,
            firstTop: first.top,
            previewPixels: images.every((image) => image.src.startsWith('data:image/png') || image.src.startsWith('data:image/jpeg')),
            nonInteractivePreview: visual && getComputedStyle(visual).pointerEvents === 'none' && !visual.querySelector('button,input,a'),
          });
        }
        if (Date.now() >= deadline) return reject(new Error('活动环境画中画折叠状态未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { collapsedPanelSize: boolean; collapsedStacked: boolean; firstLeft: number; firstTop: number; previewPixels: boolean; nonInteractivePreview: boolean };
    if (process.platform === "darwin") {
      app.setActivationPolicy("regular");
      await app.dock?.show();
      app.focus({ steal: true });
    }
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.webContents.focus();
    const focusDeadline = Date.now() + 2_000;
    while (!mainWindow.webContents.isFocused() && Date.now() < focusDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const mainFocusAcquired = mainWindow.webContents.isFocused();
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", x: 12, y: 12 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const passiveHoverFocusStable = mainFocusAcquired
      && mainWindow.webContents.isFocused()
      && !activeEnvironmentDockWindow!.isFocused();
    const nonFocusable = !activeEnvironmentDockWindow!.isFocusable();
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockHoverActions = [];
      window.__activeEnvironmentDockHoverStop?.();
      window.__activeEnvironmentDockHoverStop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'expand' || action.type === 'collapse') window.__activeEnvironmentDockHoverActions.push(action.type);
      });
      return true;
    })()`);
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`document.querySelector('[data-active-environment-dock]')?.dispatchEvent(new MouseEvent('mouseenter'))`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions = []");
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve) => {
      const panel = document.querySelector('[data-active-environment-dock]');
      panel?.dispatchEvent(new MouseEvent('mouseleave'));
      setTimeout(() => panel?.dispatchEvent(new MouseEvent('mouseenter')), 80);
      setTimeout(resolve, 360);
    })`);
    const quickReentryActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions = []");
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve) => {
      document.querySelector('[data-active-environment-dock]')?.dispatchEvent(new MouseEvent('mouseleave'));
      setTimeout(resolve, 360);
    })`);
    const sustainedLeaveActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockHoverStop?.();
      delete window.__activeEnvironmentDockHoverStop;
      delete window.__activeEnvironmentDockHoverActions;
    })()`);
    const hoverIntentStable = !quickReentryActions.includes("collapse")
      && sustainedLeaveActions.filter((type) => type === "collapse").length === 1;
    const collapsedBounds = activeEnvironmentDockWindow!.getBounds();
    const collapsedWindowSize = collapsedBounds.width === collapsedSize.width && collapsedBounds.height === collapsedSize.height;
    const expandedSize = activeEnvironmentDockPanelSize(true, environments, viewport);
    const expandedState: ActiveEnvironmentDockState = {
      ...collapsedState,
      expanded: true,
      bounds: { ...collapsedState.bounds, ...expandedSize },
    };
    await updateLayoutFromRenderer(expandedState);
    const inspected = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const panel = document.querySelector('[data-active-environment-dock]');
        const viewport = document.querySelector('.active-environment-pip__viewport');
        const cards = [...document.querySelectorAll('.active-environment-pip__card')];
        if (panel && viewport && cards.length === 2 && document.body.innerText.includes('DOCK-SMOKE-ENVIRONMENT-A') && document.body.innerText.includes('DOCK-SMOKE-DATABASE')) {
          const rect = panel.getBoundingClientRect();
          const first = cards[0].getBoundingClientRect();
          const second = cards[1].getBoundingClientRect();
          const expandedStacked = second.top - first.top >= ${card.height + 6};
          const expandedAligned = Math.abs(second.left - first.left) <= 1;
          const layoutCards = window.__activeEnvironmentDockLayoutCards || [];
          const layoutImages = window.__activeEnvironmentDockLayoutImages || [];
          if (!expandedStacked && Date.now() < deadline) return setTimeout(inspect, 20);
          return resolve({
            rendered: true,
            expandedPanelSize: rect.width === ${expandedSize.width} && rect.height === ${expandedSize.height},
            expandedStacked,
            expandedAligned,
            anchorStable: Math.abs(first.left - ${collapsedInspection.firstLeft}) <= 1 && Math.abs(first.top - ${collapsedInspection.firstTop}) <= 1,
            expandedContentFits: viewport.scrollHeight <= viewport.clientHeight,
            lightweightLayoutStable: cards.every((card, index) => card === layoutCards[index])
              && [...document.querySelectorAll('.active-environment-pip__visual img')].every((image, index) => image === layoutImages[index]),
          });
        }
        if (Date.now() >= deadline) return reject(new Error('活动环境画中画展开状态未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { rendered: boolean; expandedPanelSize: boolean; expandedStacked: boolean; expandedAligned: boolean; anchorStable: boolean; expandedContentFits: boolean; lightweightLayoutStable: boolean };
    await updateLayoutFromRenderer(collapsedState);
    const collapseStartBounds = activeEnvironmentDockWindow!.getBounds();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const collapseAnimationInspection = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-active-environment-dock]');
      const card = document.querySelectorAll('.active-environment-pip__card')[1];
      if (!panel || !card) return { panelRetained: false, compositorOnly: false };
      const transitionProperties = getComputedStyle(card).transitionProperty.split(',').map((value) => value.trim());
      return {
        panelRetained: panel.getBoundingClientRect().height === ${expandedSize.height},
        compositorOnly: transitionProperties.includes('transform')
          && !transitionProperties.includes('top')
          && !transitionProperties.includes('bottom')
          && !transitionProperties.includes('left'),
      };
    })()`) as { panelRetained: boolean; compositorOnly: boolean };
    const collapseBoundsDeferred = collapseStartBounds.width === expandedSize.width && collapseStartBounds.height === expandedSize.height;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS - 40 + 8)));
    const collapsePreResizeBounds = activeEnvironmentDockWindow!.getBounds();
    const collapsePreResizePanelHeight = await activeEnvironmentDockWindow!.webContents.executeJavaScript(
      "document.querySelector('[data-active-environment-dock]')?.getBoundingClientRect().height",
    ) as number;
    const collapseResizeSynchronized = collapsePreResizePanelHeight === collapsePreResizeBounds.height;
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS + 100));
    const collapseEndBounds = activeEnvironmentDockWindow!.getBounds();
    const collapsePanelSettled = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`document.querySelector('[data-active-environment-dock]')?.getBoundingClientRect().height === ${collapsedSize.height}`) as boolean;
    const collapseAnimationStable = collapseBoundsDeferred
      && collapseAnimationInspection.panelRetained
      && collapseAnimationInspection.compositorOnly
      && collapseEndBounds.width === collapsedSize.width
      && collapseEndBounds.height === collapsedSize.height
      && collapsePanelSettled;
    await updateLayoutFromRenderer(expandedState);
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const panel = document.querySelector('[data-active-environment-dock]');
        if (panel?.classList.contains('is-expanded') && panel.getBoundingClientRect().height === ${expandedSize.height}) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('活动环境画中画重新展开未完成'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`);
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockNativeHoverActions = [];
      window.__activeEnvironmentDockNativeHoverStop?.();
      window.__activeEnvironmentDockNativeHoverStop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'collapse') window.__activeEnvironmentDockNativeHoverActions.push(action.type);
      });
      return true;
    })()`);
    const cursor = electronScreen.getCursorScreenPoint();
    const workArea = electronScreen.getDisplayNearestPoint(cursor).workArea;
    const hoverWidth = Math.min(expandedSize.width, workArea.width);
    const hoverHeight = Math.min(expandedSize.height, workArea.height);
    const hoverBounds = {
      x: Math.min(Math.max(workArea.x, cursor.x - Math.round(hoverWidth / 2)), workArea.x + workArea.width - hoverWidth),
      y: Math.min(Math.max(workArea.y, cursor.y - Math.round(hoverHeight / 2)), workArea.y + workArea.height - hoverHeight),
      width: hoverWidth,
      height: hoverHeight,
    };
    stopActiveEnvironmentDockPointerTracking();
    activeEnvironmentDockWindow!.setBounds(hoverBounds, false);
    scheduleActiveEnvironmentDockPointerTracking();
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS + 180));
    const pointerInsideActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockNativeHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockNativeHoverActions = []");
    const awaySize = 80;
    activeEnvironmentDockWindow!.setBounds({
      x: cursor.x < workArea.x + workArea.width / 2 ? workArea.x + workArea.width - awaySize : workArea.x,
      y: cursor.y < workArea.y + workArea.height / 2 ? workArea.y + workArea.height - awaySize : workArea.y,
      width: awaySize,
      height: awaySize,
    }, false);
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS + 260));
    const pointerOutsideActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockNativeHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockNativeHoverStop?.();
      delete window.__activeEnvironmentDockNativeHoverStop;
      delete window.__activeEnvironmentDockNativeHoverActions;
    })()`);
    const nativePointerTrackingStable = !pointerInsideActions.includes("collapse")
      && pointerOutsideActions.filter((type) => type === "collapse").length === 1;
    await updateLayoutFromRenderer(expandedState);
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockProgrammaticMoveActions = [];
      window.__activeEnvironmentDockProgrammaticMoveStop?.();
      window.__activeEnvironmentDockProgrammaticMoveStop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'position') window.__activeEnvironmentDockProgrammaticMoveActions.push(action);
      });
      return true;
    })()`);
    const programmaticBounds = activeEnvironmentDockWindow!.getBounds();
    activeEnvironmentDockWindow!.setPosition(programmaticBounds.x, programmaticBounds.y + 24, false);
    await new Promise((resolve) => setTimeout(resolve, 320));
    const programmaticMoveActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockProgrammaticMoveActions") as unknown[];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockProgrammaticMoveStop?.();
      delete window.__activeEnvironmentDockProgrammaticMoveStop;
      delete window.__activeEnvironmentDockProgrammaticMoveActions;
    })()`);
    const programmaticMoveIgnored = programmaticMoveActions.length === 0;
    await updateLayoutFromRenderer(expandedState);
    const dragPositionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const timeout = setTimeout(() => { stop(); resolve(false); }, 3000);
      const stop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'position') { clearTimeout(timeout); stop(); resolve(Number.isFinite(action.x) && Number.isFinite(action.y)); }
      });
      window.__activeEnvironmentDockDragSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__activeEnvironmentDockDragSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('画中画拖动烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const dragCenter = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.active-environment-pip__open');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    const beforeDragBounds = activeEnvironmentDockWindow!.getBounds();
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockPointerEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        document.addEventListener(type, (event) => window.__activeEnvironmentDockPointerEvents.push({
          type,
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          buttons: event.buttons,
          target: event.target?.className || event.target?.tagName || '',
        }), { capture: true, once: type !== 'pointermove' });
      }
    })()`);
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", ...dragCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...dragCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", x: dragCenter.x + 34, y: dragCenter.y + 22, movementX: 34, movementY: 22 });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: dragCenter.x + 34, y: dragCenter.y + 22 });
    const dragPositionDelivered = await dragPositionPromise;
    const afterDragBounds = activeEnvironmentDockWindow!.getBounds();
    const cardDragMovedWindow = Math.abs(afterDragBounds.x - beforeDragBounds.x) >= 7 || Math.abs(afterDragBounds.y - beforeDragBounds.y) >= 7;
    if (!dragPositionDelivered || !cardDragMovedWindow) {
      const pointerEvents = await activeEnvironmentDockWindow!.webContents.executeJavaScript("window.__activeEnvironmentDockPointerEvents") as unknown;
      throw new Error(`画中画整卡拖动失败：${JSON.stringify({ beforeDragBounds, afterDragBounds, pointerEvents })}`);
    }
    await updateActiveEnvironmentDockWindow(expandedState);

    const closeActionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('画中画关闭动作未回传')); }, 3000);
      const stop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'close-environment' && action.environmentId === 'dock-smoke-environment-a') { clearTimeout(timeout); stop(); resolve(true); }
      });
      window.__activeEnvironmentDockCloseSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__activeEnvironmentDockCloseSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('画中画关闭烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const closeCenter = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.active-environment-pip__close');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", ...closeCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...closeCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...closeCenter });
    const closeActionDelivered = await closeActionPromise;
    const remainingEnvironments = environments.slice(1);
    const remainingSize = activeEnvironmentDockPanelSize(true, remainingEnvironments, viewport);
    await updateActiveEnvironmentDockWindow({
      ...expandedState,
      bounds: { ...expandedState.bounds, ...remainingSize },
      environments: remainingEnvironments,
    });
    const closeStateRemoved = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const cards = [...document.querySelectorAll('.active-environment-pip__card')];
        const images = [...document.querySelectorAll('.active-environment-pip__visual img')];
        if (cards.length === 1 && images.length === 1 && document.body.innerText.includes('DOCK-SMOKE-ENVIRONMENT-B')) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('画中画关闭后卡片未移除'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as boolean;
    await updateActiveEnvironmentDockWindow(expandedState);

    const actionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('画中画打开环境动作未回传')); }, 3000);
      const stop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'open-environment' && action.environmentId === 'dock-smoke-environment-b') { clearTimeout(timeout); stop(); resolve(true); }
      });
      window.__activeEnvironmentDockSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__activeEnvironmentDockSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('活动环境悬浮坞烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const connectionCenter = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const button = document.querySelectorAll('.active-environment-pip__card')[1];
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", ...connectionCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...connectionCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...connectionCenter });
    const actionDelivered = await actionPromise;
    const expandedBounds = activeEnvironmentDockWindow!.getBounds();
    const expandedWindowSize = expandedBounds.width === expandedSize.width && expandedBounds.height === expandedSize.height;
    const snapshot = await waitForDesktopWindowSnapshot(activeEnvironmentDockWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    const contentBounds = mainWindow.getContentBounds();
    const testViewScreenBounds = {
      x: contentBounds.x + testViewBounds.x,
      y: contentBounds.y + testViewBounds.y,
      width: testViewBounds.width,
      height: testViewBounds.height,
    };
    const overlapsWebView = expandedBounds.x < testViewScreenBounds.x + testViewScreenBounds.width
      && expandedBounds.x + expandedBounds.width > testViewScreenBounds.x
      && expandedBounds.y < testViewScreenBounds.y + testViewScreenBounds.height
      && expandedBounds.y + expandedBounds.height > testViewScreenBounds.y;
    const nativeAboveWebView = activeEnvironmentDockWindow!.getParentWindow() === mainWindow
      && activeEnvironmentDockWindow!.isVisible() && webViewStayedVisible && overlapsWebView;
    await updateActiveEnvironmentDockWindow(null);
    return {
      ...inspected,
      ...collapsedInspection,
      collapsedPanelSize: collapsedInspection.collapsedPanelSize && collapsedWindowSize,
      expandedPanelSize: inspected.expandedPanelSize && expandedWindowSize,
      rendererPreviewPixels,
      previewFrameChanged,
      retainedPreviewPixels,
      nonFocusable,
      passiveHoverFocusStable,
      hoverIntentStable,
      nativePointerTrackingStable,
      collapseAnimationStable,
      collapseResizeSynchronized,
      lightweightLayoutStable: inspected.lightweightLayoutStable,
      programmaticMoveIgnored,
      dragPositionDelivered: dragPositionDelivered && cardDragMovedWindow,
      closeActionDelivered,
      closeStateRemoved,
      snapshot,
      webViewStayedVisible,
      nativeAboveWebView,
      actionDelivered,
      hidden: !activeEnvironmentDockWindow!.isVisible(),
    };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
    await updateActiveEnvironmentDockWindow(null);
  }
}
