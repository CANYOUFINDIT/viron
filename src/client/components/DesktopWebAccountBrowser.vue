<script setup lang="ts">import { translate as tr } from "../i18n";

import { ArrowLeft, ArrowRight, ExternalLink, FolderPlus, Globe2, KeyRound, Laptop, LoaderCircle, Maximize2, Minimize2, Plus, Puzzle, RefreshCw, RotateCcw, ShieldAlert } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { loadActiveConnections } from "../active-connections";
import {
  captureDesktopWebView,
  closeDesktopWebView,
  desktopWebViewAction,
  importDesktopChromeExtension,
  installDesktopWebExtension,
  listDesktopWebExtensions,
  onDesktopWebViewState,
  onDesktopNativeViewPointerDown,
  openDesktopWebView,
  openChromeWebStore,
  removeDesktopWebExtension,
  scanDesktopChromeExtensions,
  setDesktopWebViewVisible,
  setDesktopWebViewPreviewing,
  updateDesktopWebViewBounds,
  type DesktopWebViewAction,
  type DesktopWebViewBounds,
  type DesktopWebViewState,
  type DesktopWebExtensionInfo,
  type DesktopChromeExtensionInfo,
} from "../desktop";
import { releaseAgentNativeOverlay, retainAgentNativeOverlay } from "../agent-host";
import { desktopWebBoundsOutsideSidebar, rendererOverlayCoversSurface, type RectangleBounds } from "../desktop-web-overlay";
import { normalizeWebAddress } from "../../shared/web-address";
import { historyNavigationFromMouseButton } from "../../shared/history-navigation-gesture";
import { applyHistoryNavigationCommand, applyHistoryNavigationWheel } from "../history-navigation";
import type { TlsWebEntryBadge } from "../../shared/tls-certificates";
import TlsPopover from "./credentials/TlsPopover.vue";
import WebPageTabStrip from "./WebPageTabStrip.vue";

const props = withDefaults(defineProps<{
  environmentId: string;
  credentialId: string;
  entryId: string;
  entryName: string;
  username: string;
  entryUrl: string;
  entryTls?: TlsWebEntryBadge | null;
  relatedTlsEntries?: Array<{ id: string; name: string; url: string }>;
  active: boolean;
  focused: boolean;
  preview?: boolean;
  autoStart?: boolean;
  preloadStart?: boolean;
}>(), { preview: false, autoStart: false, preloadStart: false });
const emit = defineEmits<{
  focusChange: [focused: boolean];
  previewFrame: [dataUrl: string];
  configureEntryHttps: [];
  tlsRefreshed: [];
}>();

const surface = ref<HTMLElement | null>(null);
const state = ref<DesktopWebViewState | null>(null);
const address = ref(props.entryUrl);
const startError = ref("");
const started = ref(false);
const starting = ref(false);
const resetting = ref(false);
const extensionsOpen = ref(false);
const extensionsBusy = ref(false);
const extensions = ref<DesktopWebExtensionInfo[]>([]);
const extensionsLoading = ref(false);
const chromeExtensions = ref<DesktopChromeExtensionInfo[]>([]);
const chromeScanning = ref(false);
const previewFrame = ref("");
const overlayBlocking = ref(false);
const overlayFrame = ref("");
const pageTabs = computed(() => state.value?.pages ?? []);
const activePageId = computed(() => state.value?.activePageId ?? "");
let resizeObserver: ResizeObserver | null = null;
let overlayObserver: MutationObserver | null = null;
let stopStateListener: (() => void) | null = null;
let boundsFrame: number | undefined;
let lastNativeBounds: { id: string; bounds: DesktopWebViewBounds } | null = null;
let componentActive = true;
let closed = false;
let lastNoticeId = "";
let lastPageError = "";
let nativeOverlayHeld = false;
let pendingNewPage = false;
let previewTimer: number | undefined;
let previewSyncSequence = 0;
let overlayFreezeSeq = 0;
const preloading = ref(false);
let removeNativeViewPointerDownListener: (() => void) | null = null;
let startRequestVersion = 0;
let startPromise: Promise<void> | null = null;
let releasePromise: Promise<void> | null = null;

function elementBounds(element: HTMLElement): RectangleBounds {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function surfaceBounds(): DesktopWebViewBounds | null {
  if (!surface.value) return null;
  let surfaceRect: RectangleBounds | null = elementBounds(surface.value);
  const appFrame = document.querySelector(".app-frame");
  const sidebar = appFrame?.querySelector<HTMLElement>(".app-sidebar");
  const sidebarPanel = sidebar?.querySelector<HTMLElement>(".app-sidebar__panel");
  if (sidebar && sidebarPanel && window.getComputedStyle(sidebar).display !== "none") {
    surfaceRect = desktopWebBoundsOutsideSidebar(
      surfaceRect,
      elementBounds(sidebar),
      elementBounds(sidebarPanel),
      appFrame?.classList.contains("is-sidebar-expanded") ?? false,
    );
  }
  if (!surfaceRect) return null;
  if (surfaceRect.width < 2 || surfaceRect.height < 2) return null;
  return {
    x: Math.round(surfaceRect.left),
    y: Math.round(surfaceRect.top),
    width: Math.round(surfaceRect.width),
    height: Math.round(surfaceRect.height),
  };
}

function updateNativeBounds(id: string, bounds: DesktopWebViewBounds) {
  const previous = lastNativeBounds;
  if (previous?.id === id && previous.bounds.x === bounds.x && previous.bounds.y === bounds.y
    && previous.bounds.width === bounds.width && previous.bounds.height === bounds.height) return;
  lastNativeBounds = { id, bounds };
  void updateDesktopWebViewBounds(id, bounds).catch(() => { lastNativeBounds = null; });
}

function applyState(next: DesktopWebViewState) {
  if (next.credentialId !== props.credentialId) return;
  if (!started.value && !state.value) return;
  if (state.value?.id && state.value.id !== next.id) return;
  state.value = next;
  address.value = next.url === "about:blank" ? "" : next.url;
  if (next.closedReason) startError.value = next.closedReason;
  if (next.error && next.error !== lastPageError) ElMessage.error(next.error);
  lastPageError = next.error;
  if (next.notice && next.notice.id !== lastNoticeId) {
    lastNoticeId = next.notice.id;
    ElMessage[next.notice.type](next.notice.message);
  }
}

function scheduleBounds() {
  if (props.preview) return;
  if (boundsFrame) return;
  boundsFrame = window.requestAnimationFrame(() => {
    boundsFrame = undefined;
    const bounds = surfaceBounds();
    if (state.value && bounds) updateNativeBounds(state.value.id, bounds);
  });
}

function rendererOverlayVisible() {
  const surfaceRect = surface.value?.getBoundingClientRect();
  if (!surfaceRect) return false;
  return [...document.querySelectorAll<HTMLElement>(".el-overlay, .el-popper")].some((overlay) => {
    const style = window.getComputedStyle(overlay);
    const rect = overlay.getBoundingClientRect();
    return rendererOverlayCoversSurface(surfaceRect, {
      rect,
      ariaHidden: overlay.getAttribute("aria-hidden") === "true",
      display: style.display,
      visibility: style.visibility,
      ignored: overlay.classList.contains("sidebar-user-popper"),
    });
  });
}

function onSidebarTransitionEnd(event: TransitionEvent) {
  if (event.propertyName === "width" && event.target instanceof Element && event.target.classList.contains("app-sidebar")) syncVisibility();
}

function syncNativeOverlay(needed: boolean) {
  if (needed === nativeOverlayHeld) return;
  nativeOverlayHeld = needed;
  if (needed) retainAgentNativeOverlay();
  else releaseAgentNativeOverlay();
}

function clearOverlayFreeze() {
  overlayFreezeSeq += 1;
  overlayBlocking.value = false;
  overlayFrame.value = "";
}

async function freezePageForOverlay(id: string) {
  if (overlayBlocking.value) return;
  overlayBlocking.value = true;
  const seq = ++overlayFreezeSeq;
  if (!overlayFrame.value && previewFrame.value) overlayFrame.value = previewFrame.value;
  window.clearTimeout(previewTimer);
  syncNativeOverlay(false);
  const pendingCapture = captureDesktopWebView(id, "page").catch(() => "");
  void setDesktopWebViewVisible(id, false).then(applyState).catch(() => undefined);
  const frame = await pendingCapture;
  if (seq !== overlayFreezeSeq || state.value?.id !== id) return;
  if (frame) overlayFrame.value = frame;
}

function syncVisibility() {
  if (!state.value || state.value.closedReason) {
    clearOverlayFreeze();
    syncNativeOverlay(false);
    return;
  }
  if (props.preview) {
    clearOverlayFreeze();
    window.clearTimeout(previewTimer);
    syncNativeOverlay(false);
    void setDesktopWebViewVisible(state.value.id, false).then(applyState).catch(() => undefined);
    return;
  }
  const bounds = surfaceBounds();
  const overlay = rendererOverlayVisible();
  const canShow = componentActive && props.active && !preloading.value && Boolean(bounds);
  if (canShow && overlay) {
    void freezePageForOverlay(state.value.id);
    return;
  }
  if (overlayBlocking.value) clearOverlayFreeze();
  const visible = canShow;
  syncNativeOverlay(visible);
  if (visible && bounds) updateNativeBounds(state.value.id, bounds);
  void setDesktopWebViewVisible(state.value.id, visible).then((next) => {
    applyState(next);
    if (visible) schedulePreviewCapture(120);
    else window.clearTimeout(previewTimer);
  }).catch(() => undefined);
}

function schedulePreviewCapture(delay = 900) {
  window.clearTimeout(previewTimer);
  if (props.preview || overlayBlocking.value || !props.active || !state.value || state.value.closedReason || document.visibilityState === "hidden") return;
  previewTimer = window.setTimeout(() => void refreshPreviewFrame(), delay);
}

async function refreshPreviewFrame() {
  const id = state.value?.id;
  if (!id || !props.active || document.visibilityState === "hidden") return;
  try {
    const frame = await captureDesktopWebView(id);
    if (frame && state.value?.id === id && props.active) {
      previewFrame.value = frame;
      emit("previewFrame", frame);
    }
  } catch {
    // The normal disconnected state remains visible while capture is unavailable.
  } finally {
    if (!props.preview && !overlayBlocking.value) schedulePreviewCapture();
  }
}

async function syncPreviewMode() {
  const sequence = ++previewSyncSequence;
  const id = state.value?.id;
  if (!id) return syncVisibility();
  const previewing = props.preview && props.active;
  if (previewing) {
    window.clearTimeout(previewTimer);
    await refreshPreviewFrame();
  }
  await setDesktopWebViewPreviewing(id, previewing).catch(() => undefined);
  if (sequence !== previewSyncSequence || state.value?.id !== id) return;
  syncVisibility();
}

async function runAction(type: DesktopWebViewAction["type"], url?: string, pageId?: string, orderedPageIds?: string[]) {
  if (!state.value) return;
  try {
    applyState(await desktopWebViewAction(state.value.id, { type, url, pageId, orderedPageIds }));
  } catch (error) {
    startError.value = error instanceof Error ? error.message : tr("本机页面操作失败");
  }
}

function navigate() {
  const url = normalizeWebAddress(address.value);
  if (!url) {
    ElMessage.warning(tr("请输入有效的网站地址"));
    return;
  }
  address.value = url;
  void runAction("navigate", url);
}

function closePage(pageId: string) {
  if (!state.value || state.value.pages.length <= 1) return;
  void runAction("close-page", undefined, pageId);
}

function activatePage(pageId: string) {
  if (!state.value) {
    void start();
    return;
  }
  void runAction("activate-page", undefined, pageId);
}

function createBlankPage() {
  if (state.value) {
    void runAction("new-page");
    return;
  }
  if (starting.value) {
    pendingNewPage = true;
    return;
  }
  void start("blank");
}

function reorderPages(orderedPageIds: string[]) {
  void runAction("reorder-pages", undefined, undefined, orderedPageIds);
}

async function resetLogin() {
  if (!state.value || resetting.value) return;
  try {
    await ElMessageBox.confirm(tr("将清除 {0} 在当前电脑上的 Cookie、缓存和本地存储，然后重新打开登录页。", [props.username]), tr("重新登录"), {
      type: "warning",
      confirmButtonText: tr("清除并重新登录"),
      cancelButtonText: tr("取消"),
    });
    resetting.value = true;
    applyState(await desktopWebViewAction(state.value.id, { type: "reset" }));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("重新登录失败"));
  } finally {
    resetting.value = false;
  }
}

async function openExtensions() {
  if (!state.value) return;
  extensions.value = [];
  extensionsLoading.value = true;
  try {
    extensions.value = await listDesktopWebExtensions(state.value.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取本机扩展失败"));
  } finally {
    extensionsLoading.value = false;
  }
  await refreshChromeExtensions();
}

async function refreshChromeExtensions() {
  if (chromeScanning.value) return;
  chromeScanning.value = true;
  try {
    chromeExtensions.value = await scanDesktopChromeExtensions();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("扫描 Chrome 扩展失败"));
  } finally {
    chromeScanning.value = false;
  }
}

async function importChromeExtension(extension: DesktopChromeExtensionInfo) {
  if (!state.value || extensionsBusy.value) return;
  extensionsBusy.value = true;
  try {
    extensions.value = await importDesktopChromeExtension(state.value.id, extension.token);
    ElMessage.success(tr("扩展已安装；刷新页面后生效"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导入 Chrome 扩展失败"));
  } finally {
    extensionsBusy.value = false;
  }
}

function chromeExtensionAdded(chromeId: string): boolean {
  return extensions.value.some((extension) => extension.chromeId === chromeId);
}

function chromeProfileName(profile: string): string {
  return profile === "Default" ? tr("默认资料") : profile.replace("Profile ", tr("资料 "));
}

async function openChromeStore() {
  try {
    await openChromeWebStore();
    extensionsOpen.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("打开 Chrome 扩展商店失败"));
  }
}

async function installExtension() {
  if (!state.value || extensionsBusy.value) return;
  extensionsBusy.value = true;
  try {
    const result = await installDesktopWebExtension(state.value.id);
    extensions.value = result.items;
    if (!result.canceled) ElMessage.success(tr("扩展已安装；刷新页面后生效"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("安装本机扩展失败"));
  } finally {
    extensionsBusy.value = false;
  }
}

async function removeExtension(extension: DesktopWebExtensionInfo) {
  if (!state.value || extensionsBusy.value) return;
  try {
    await ElMessageBox.confirm(tr("从当前 Web 账号移除扩展「{0}」及其本机文件？", [extension.name]), tr("移除扩展"), {
      type: "warning",
      confirmButtonText: tr("移除"),
      cancelButtonText: tr("取消"),
    });
    extensionsBusy.value = true;
    extensions.value = await removeDesktopWebExtension(state.value.id, extension.installId);
    ElMessage.success(tr("扩展已移除；刷新页面后生效"));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("移除本机扩展失败"));
  } finally {
    extensionsBusy.value = false;
  }
}

function claimPreloadedView() {
  if (!preloading.value) return;
  preloading.value = false;
  syncVisibility();
}

async function releasePreloadedView() {
  if (!preloading.value) return releasePromise ?? Promise.resolve();
  if (releasePromise) return releasePromise;
  preloading.value = false;
  startRequestVersion += 1;
  starting.value = false;
  started.value = false;
  const release = (async () => {
    await startPromise?.catch(() => undefined);
    const id = state.value?.id;
    state.value = null;
    startError.value = "";
    if (!id) return;
    const closeRequest = closeDesktopWebView(id).catch(() => undefined);
    window.setTimeout(() => void loadActiveConnections().catch(() => undefined), 120);
    await closeRequest;
    void loadActiveConnections().catch(() => undefined);
  })();
  releasePromise = release;
  try {
    await release;
  } finally {
    if (releasePromise === release) releasePromise = null;
  }
}

async function start(initialPage: "entry" | "blank" = "entry", preload = false) {
  await releasePromise;
  if (state.value && !state.value.closedReason) {
    if (!preload) claimPreloadedView();
    return;
  }
  if (startPromise) {
    if (!preload) claimPreloadedView();
    return startPromise;
  }
  const requestVersion = ++startRequestVersion;
  const task = (async () => {
    preloading.value = preload;
    started.value = true;
    starting.value = true;
    startError.value = "";
    await nextTick();
    const bounds = surfaceBounds();
    if (!bounds) {
      preloading.value = false;
      started.value = false;
      startError.value = preload ? "" : tr("本机页面区域尚未准备完成");
      return;
    }
    try {
      const opened = await openDesktopWebView(props.credentialId, bounds, initialPage, props.environmentId);
      if (closed || requestVersion !== startRequestVersion) {
        await closeDesktopWebView(opened.id);
        return;
      }
      applyState(opened);
      await syncPreviewMode();
      void loadActiveConnections().catch(() => undefined);
      if (pendingNewPage) {
        pendingNewPage = false;
        applyState(await desktopWebViewAction(opened.id, { type: "new-page" }));
      }
    } catch (error) {
      if (requestVersion !== startRequestVersion) return;
      pendingNewPage = false;
      preloading.value = false;
      started.value = !preload;
      startError.value = preload ? "" : error instanceof Error ? error.message : tr("本机账号页面启动失败");
    } finally {
      if (requestVersion === startRequestVersion) starting.value = false;
    }
  })();
  startPromise = task;
  try {
    await task;
  } finally {
    if (startPromise === task) startPromise = null;
  }
}

function reconnect() {
  state.value = null;
  startError.value = "";
  void start();
}

function visitPage() {
  if (state.value) claimPreloadedView();
  else void start();
}

function shouldIgnoreIdleSurfaceEvent(event: Event) {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest(".web-browser-idle"));
}

function handleBrowserInteraction(event: Event) {
  if (shouldIgnoreIdleSurfaceEvent(event)) return;
  claimPreloadedView();
}

function handleHistoryMouseButton(event: MouseEvent) {
  const direction = historyNavigationFromMouseButton(event.button);
  if (!direction) return;
  event.preventDefault();
  if (event.type === "mouseup") applyHistoryNavigationCommand(direction);
}

function handleHistoryWheel(event: WheelEvent) {
  if (event.target instanceof Element && event.target.closest("input, textarea, button, .web-page-tabs")) return;
  const next = applyHistoryNavigationWheel(event, performance.now(), { ignoreBlockedTargets: true });
  if (next.status !== "idle") {
    event.preventDefault();
    event.stopPropagation();
  }
}

onMounted(() => {
  stopStateListener = onDesktopWebViewState(applyState);
  removeNativeViewPointerDownListener = onDesktopNativeViewPointerDown(() => {
    if (props.active && state.value) claimPreloadedView();
  });
  resizeObserver = new ResizeObserver(scheduleBounds);
  if (surface.value) resizeObserver.observe(surface.value);
  overlayObserver = new MutationObserver(syncVisibility);
  overlayObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "class", "style"],
  });
  window.addEventListener("resize", syncVisibility);
  window.addEventListener("scroll", scheduleBounds, true);
  document.addEventListener("transitionend", onSidebarTransitionEnd, true);
  document.addEventListener("visibilitychange", syncPreviewMode);
  if (props.autoStart) void start("entry", props.preloadStart);
});

onActivated(() => {
  componentActive = true;
  void nextTick(syncVisibility);
});

onDeactivated(() => {
  componentActive = false;
  clearOverlayFreeze();
  syncNativeOverlay(false);
  if (boundsFrame) {
    window.cancelAnimationFrame(boundsFrame);
    boundsFrame = undefined;
  }
  if (state.value && !state.value.closedReason) {
    void setDesktopWebViewVisible(state.value.id, false).then(applyState).catch(() => undefined);
  }
});

watch(
  () => props.entryUrl,
  (entryUrl) => {
    if (!started.value) address.value = entryUrl;
  },
);

watch(
  [() => props.active, () => props.preview, () => state.value?.id],
  () => syncPreviewMode(),
  { immediate: true },
);

watch(
  [() => props.autoStart, () => props.preloadStart],
  ([autoStart, preloadStart]) => {
    if (autoStart && !started.value) void start("entry", preloadStart);
    else if (!autoStart) void releasePreloadedView();
    else if (!preloadStart) claimPreloadedView();
  },
);

onBeforeUnmount(() => {
  closed = true;
  clearOverlayFreeze();
  syncNativeOverlay(false);
  if (boundsFrame) window.cancelAnimationFrame(boundsFrame);
  window.clearTimeout(previewTimer);
  resizeObserver?.disconnect();
  overlayObserver?.disconnect();
  stopStateListener?.();
  removeNativeViewPointerDownListener?.();
  window.removeEventListener("resize", syncVisibility);
  window.removeEventListener("scroll", scheduleBounds, true);
  document.removeEventListener("transitionend", onSidebarTransitionEnd, true);
  document.removeEventListener("visibilitychange", syncPreviewMode);
  if (state.value) {
    void setDesktopWebViewPreviewing(state.value.id, false).catch(() => undefined);
    void closeDesktopWebView(state.value.id)
      .then(() => loadActiveConnections())
      .catch(() => undefined);
  }
});
</script>

<template>
  <section class="web-account-browser desktop-web-account-browser" @pointerdown.capture="handleBrowserInteraction" @keydown.capture="handleBrowserInteraction" @mousedown.capture="handleHistoryMouseButton" @mouseup.capture="handleHistoryMouseButton" @wheel.capture="handleHistoryWheel">
    <WebPageTabStrip
      :pages="pageTabs"
      :active-page-id="activePageId"
      @activate="activatePage"
      @close="closePage"
      @create="createBlankPage"
      @reorder="reorderPages"
    />
    <header class="web-browser-toolbar">
      <div class="web-browser-nav">
        <button type="button" :aria-label="$t('后退')" :title="$t('后退')" :disabled="!state?.canGoBack" @click="runAction('back')"><ArrowLeft :size="15" /></button>
        <button type="button" :aria-label="$t('前进')" :title="$t('前进')" :disabled="!state?.canGoForward" @click="runAction('forward')"><ArrowRight :size="15" /></button>
        <button type="button" :aria-label="$t('刷新')" :title="$t('刷新')" :disabled="!state || Boolean(state.closedReason)" @click="runAction('reload')"><RefreshCw :size="15" /></button>
      </div>
      <form class="web-browser-address" @submit.prevent="navigate">
        <TlsPopover
          icon-only
          :tls="entryTls"
          :entry-id="entryId"
          :entry-name="entryName"
          :entry-url="address || entryUrl"
          :related-entries="relatedTlsEntries"
          @configure-https="emit('configureEntryHttps')"
          @refreshed="emit('tlsRefreshed')"
        />
        <input v-model="address" :aria-label="$t('页面地址')" autocomplete="off" spellcheck="false" :readonly="!state" />
      </form>
      <div class="web-browser-tools">
        <button type="button" :aria-label="$t('新建空白标签页')" :title="$t('新建空白标签页')" @click="createBlankPage"><Plus :size="15" /></button>
        <el-popover v-model:visible="extensionsOpen" placement="bottom-end" trigger="click" :width="360" :offset="8" @show="openExtensions">
          <template #reference>
            <button type="button" :aria-label="$t('本地拓展')" :title="$t('本地拓展')" :disabled="!state || Boolean(state.closedReason)"><Puzzle :size="15" /></button>
          </template>
          <div class="desktop-web-extensions">
            <div class="desktop-web-extensions__heading"><strong>{{ $t('本地拓展') }}</strong><button type="button" :aria-label="$t('刷新 Chrome 拓展列表')" :title="$t('刷新 Chrome 拓展列表')" :disabled="chromeScanning" @click="refreshChromeExtensions"><RefreshCw :size="14" :class="{ 'is-spinning': chromeScanning }" /></button></div>
            <div class="desktop-web-extensions__section">
              <span class="desktop-web-extensions__label">{{ $t('当前账号') }}</span>
              <span v-if="extensionsLoading" class="desktop-web-extensions__empty">{{ $t('正在加载…') }}</span>
              <span v-else-if="!extensions.length" class="desktop-web-extensions__empty">{{ $t('尚未添加拓展') }}</span>
              <div v-for="extension in extensions" :key="extension.installId" class="desktop-web-extensions__item">
                <div><strong>{{ extension.name }}</strong><small>{{ extension.error || `v${extension.version}` }}</small></div>
                <button type="button" :disabled="extensionsBusy" @click="removeExtension(extension)">{{ $t('移除') }}</button>
              </div>
            </div>
            <div class="desktop-web-extensions__section desktop-web-extensions__chrome">
              <span class="desktop-web-extensions__label">{{ $t('Chrome 中的拓展') }}</span>
              <span v-if="chromeScanning" class="desktop-web-extensions__empty">{{ $t('正在扫描…') }}</span>
              <span v-else-if="!chromeExtensions.length" class="desktop-web-extensions__empty">{{ $t('未找到 Chrome 拓展') }}</span>
              <div v-for="extension in chromeExtensions" :key="extension.token" class="desktop-web-extensions__item">
                <div><strong>{{ extension.name }}</strong><small>{{ chromeProfileName(extension.profile) }} · v{{ extension.version }}</small></div>
                <button type="button" :disabled="extensionsBusy || chromeExtensionAdded(extension.chromeId)" @click="importChromeExtension(extension)">{{ chromeExtensionAdded(extension.chromeId) ? $t('已添加') : $t('导入') }}</button>
              </div>
            </div>
            <div class="desktop-web-extensions__actions">
              <button type="button" :disabled="extensionsBusy" @click="installExtension"><FolderPlus :size="15" />{{ $t('导入文件夹') }}</button>
              <button type="button" :title="$t('在 Chrome 安装后，返回刷新并导入')" @click="openChromeStore"><ExternalLink :size="14" />{{ $t('Chrome 商店') }}</button>
            </div>
          </div>
        </el-popover>
        <span v-if="state?.certificateError" class="desktop-web-view-status is-certificate-error-status" :title="$t('页面证书校验失败')"><ShieldAlert :size="15" /></span>
        <span v-else-if="state?.loading" class="desktop-web-view-status" :title="$t('本机页面加载中')"><LoaderCircle :size="14" class="is-spinning" /></span>
        <span v-else class="desktop-web-view-status is-local" :title="state?.autofillMessage || $t('页面由当前电脑本机直接访问')"><Laptop :size="14" /></span>
        <button type="button" :aria-label="$t('重新填充账号密码')" :title="$t('在入口原始域名的当前页面重新填充账号密码')" :disabled="!state" @click="runAction('refill')"><KeyRound :size="15" /></button>
        <button type="button" :aria-label="$t('重新登录')" :title="$t('清除本机登录状态并重新登录')" :disabled="!state || resetting" @click="resetLogin"><RotateCcw :size="15" /></button>
        <button type="button" :aria-label="focused ? $t('退出沉浸模式') : $t('进入沉浸模式')" :title="focused ? $t('退出沉浸模式') : $t('进入沉浸模式')" @click="emit('focusChange', !focused)"><Minimize2 v-if="focused" :size="15" /><Maximize2 v-else :size="15" /></button>
      </div>
    </header>
    <div ref="surface" class="web-browser-surface desktop-web-browser-surface" :class="{ 'is-preview': preview, 'is-overlay-frozen': overlayBlocking }">
      <img v-if="preview && previewFrame" :src="previewFrame" :alt="$t('{0} 的页面画面', [username])" draggable="false" />
      <img v-else-if="overlayBlocking && (overlayFrame || previewFrame)" :src="overlayFrame || previewFrame" :alt="$t('{0} 的页面画面', [username])" draggable="false" />
      <div v-else-if="!started || preloading" class="web-browser-loading web-browser-idle" :title="$t('双击空白处访问页面')" @pointerdown.stop @mousedown.stop @dblclick="visitPage">
        <div class="web-browser-idle__icon"><Globe2 :size="24" /></div>
        <strong>{{ $t('准备访问此页面') }}</strong>
        <span>{{ $t('双击空白处或点击下方按钮，将建立本机 Web 连接并加载上方地址。') }}</span>
        <button type="button" @click.stop="visitPage"><Globe2 :size="15" />{{ $t('访问页面') }}</button>
      </div>
      <div v-else-if="!state" class="web-browser-loading">
        <LoaderCircle v-if="!startError" :size="25" class="is-spinning" />
        <strong>{{ startError ? $t('本机页面暂时不可用') : $t('正在本机打开 {0}', [username]) }}</strong>
        <span>{{ startError || $t('请先确认 Viron 的安全存储说明；操作系统可能继续请求安全存储授权') }}</span>
        <button v-if="startError" type="button" @click="startError = ''; start()">{{ $t('重新连接') }}</button>
      </div>
      <div v-else-if="state.certificateError" class="web-browser-loading is-certificate-error">
        <div class="web-browser-certificate-icon"><ShieldAlert :size="28" /></div>
        <strong>{{ $t('您的连接不是私密连接') }}</strong>
        <span>{{ $t('此页面的 HTTPS 证书无法通过校验。只有在确认目标地址可信时，才继续访问。') }}</span>
        <code>{{ state.certificateError.url }}</code>
        <div class="web-browser-certificate-actions">
          <button type="button" @click="runAction('continue-certificate')">{{ $t('继续访问（不安全）') }}</button>
          <button type="button" class="is-secondary" @click="runAction('reload')">{{ $t('重新加载') }}</button>
        </div>
      </div>
      <div v-else-if="state.closedReason" class="web-browser-loading is-disconnected">
        <strong>{{ $t('页面连接已断开') }}</strong>
        <span>{{ state.closedReason }}{{ $t('；当前页面现场保留到你关闭此工作区为止。') }}</span>
        <button type="button" @click="reconnect">{{ $t('重新连接') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.desktop-web-account-browser { position: relative; }
.desktop-web-browser-surface { background: #fff; }
.desktop-web-browser-surface.is-preview,
.desktop-web-browser-surface.is-overlay-frozen { cursor: default; }
.desktop-web-view-status { width: 28px; height: 28px; color: var(--ink-400); display: grid; place-items: center; }
.desktop-web-view-status.is-local { color: var(--teal-600); }
.desktop-web-view-status.is-certificate-error-status { color: #d93025; }
.web-browser-nav button:disabled, .web-browser-tools button:disabled { opacity: .34; cursor: not-allowed; }
.web-browser-certificate-icon { width: 56px; height: 56px; margin-bottom: 4px; border-radius: 50%; background: #fff1f0; color: #d93025; display: grid; place-items: center; }
.is-certificate-error strong { color: #202124; font-size: 17px; }
.is-certificate-error span { max-width: 420px; line-height: 1.6; }
.is-certificate-error code { max-width: min(520px, 90%); overflow: hidden; color: #5f6368; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.web-browser-certificate-actions { display: flex; align-items: center; gap: 8px; }
.web-browser-certificate-actions button.is-secondary { border-color: #9aa0a6; background: #fff; color: #5f6368; }
.web-browser-certificate-actions button.is-secondary:hover { border-color: #5f6368; background: #f8f9fa; }
.desktop-web-extensions { display: grid; gap: 12px; color: var(--ink-900); }
.desktop-web-extensions__heading { display: flex; align-items: center; justify-content: space-between; padding: 2px 2px 0; }
.desktop-web-extensions__heading strong { font-size: 15px; }
.desktop-web-extensions__heading button { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--ink-500); cursor: pointer; }
.desktop-web-extensions__heading button:hover { background: var(--surface-50, #f3f6f5); }
.desktop-web-extensions__section { display: grid; gap: 5px; }
.desktop-web-extensions__label { padding: 0 2px; color: var(--ink-400); font-size: 11px; font-weight: 600; }
.desktop-web-extensions__empty { padding: 8px 2px; color: var(--ink-400); font-size: 12px; }
.desktop-web-extensions__chrome { max-height: 250px; overflow-y: auto; border-top: 1px solid var(--line-200, #e1e8e5); padding-top: 10px; }
.desktop-web-extensions__item { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 42px; padding: 5px 7px; border-radius: 7px; }
.desktop-web-extensions__item:hover { background: var(--surface-50, #f3f6f5); }
.desktop-web-extensions__item div { display: grid; gap: 2px; min-width: 0; }
.desktop-web-extensions__item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.desktop-web-extensions__item small { overflow: hidden; color: var(--ink-400); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.desktop-web-extensions__item button { flex: none; border: 0; background: none; color: var(--teal-600); font-size: 12px; cursor: pointer; }
.desktop-web-extensions__item button:disabled, .desktop-web-extensions__actions button:disabled { opacity: .45; cursor: not-allowed; }
.desktop-web-extensions__actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--line-200, #e1e8e5); padding-top: 10px; }
.desktop-web-extensions__actions button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 2px; border: 0; background: none; color: var(--teal-600); font-size: 12px; font-weight: 600; cursor: pointer; }
</style>
