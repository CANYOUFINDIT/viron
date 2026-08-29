<script setup lang="ts">import { translate as tr } from "../i18n";

import { ArrowLeft, ArrowRight, Globe2, KeyRound, Laptop, LoaderCircle, Maximize2, Minimize2, Plus, RefreshCw, RotateCcw } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { loadActiveConnections } from "../active-connections";
import {
  captureDesktopWebView,
  closeDesktopWebView,
  desktopWebViewAction,
  onDesktopWebViewState,
  onDesktopNativeViewPointerDown,
  openDesktopWebView,
  setDesktopWebViewVisible,
  setDesktopWebViewPreviewing,
  updateDesktopWebViewBounds,
  type DesktopWebViewAction,
  type DesktopWebViewBounds,
  type DesktopWebViewState,
} from "../desktop";
import { releaseAgentNativeOverlay, retainAgentNativeOverlay } from "../agent-host";
import { rendererOverlayCoversSurface, type RectangleBounds } from "../desktop-web-overlay";
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
const previewFrame = ref("");
const pageTabs = computed(() => state.value?.pages ?? []);
const activePageId = computed(() => state.value?.activePageId ?? "");
let resizeObserver: ResizeObserver | null = null;
let overlayObserver: MutationObserver | null = null;
let stopStateListener: (() => void) | null = null;
let boundsFrame: number | undefined;
let componentActive = true;
let closed = false;
let lastNoticeId = "";
let lastPageError = "";
let nativeOverlayHeld = false;
let pendingNewPage = false;
let previewTimer: number | undefined;
let previewSyncSequence = 0;
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
  const surfaceRect = elementBounds(surface.value);
  if (surfaceRect.width < 2 || surfaceRect.height < 2) return null;
  return {
    x: Math.round(surfaceRect.left),
    y: Math.round(surfaceRect.top),
    width: Math.round(surfaceRect.width),
    height: Math.round(surfaceRect.height),
  };
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
    if (state.value && bounds) void updateDesktopWebViewBounds(state.value.id, bounds).catch(() => undefined);
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

function syncNativeOverlay(needed: boolean) {
  if (needed === nativeOverlayHeld) return;
  nativeOverlayHeld = needed;
  if (needed) retainAgentNativeOverlay();
  else releaseAgentNativeOverlay();
}

function syncVisibility() {
  if (!state.value || state.value.closedReason) {
    syncNativeOverlay(false);
    return;
  }
  if (props.preview) {
    window.clearTimeout(previewTimer);
    syncNativeOverlay(false);
    void setDesktopWebViewVisible(state.value.id, false).then(applyState).catch(() => undefined);
    return;
  }
  const bounds = surfaceBounds();
  const visible = componentActive && props.active && !preloading.value && Boolean(bounds) && !rendererOverlayVisible();
  syncNativeOverlay(visible);
  void setDesktopWebViewVisible(state.value.id, visible).then((next) => {
    applyState(next);
    if (visible) schedulePreviewCapture(120);
    else window.clearTimeout(previewTimer);
  }).catch(() => undefined);
  if (visible && bounds) scheduleBounds();
}

function schedulePreviewCapture(delay = 900) {
  window.clearTimeout(previewTimer);
  if (props.preview || !props.active || !state.value || state.value.closedReason || document.visibilityState === "hidden") return;
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
    if (!props.preview) schedulePreviewCapture();
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
  window.addEventListener("resize", scheduleBounds);
  window.addEventListener("scroll", scheduleBounds, true);
  document.addEventListener("visibilitychange", syncPreviewMode);
  if (props.autoStart) void start("entry", props.preloadStart);
});

onActivated(() => {
  componentActive = true;
  void nextTick(syncVisibility);
});

onDeactivated(() => {
  componentActive = false;
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
  syncNativeOverlay(false);
  if (boundsFrame) window.cancelAnimationFrame(boundsFrame);
  window.clearTimeout(previewTimer);
  resizeObserver?.disconnect();
  overlayObserver?.disconnect();
  stopStateListener?.();
  removeNativeViewPointerDownListener?.();
  window.removeEventListener("resize", scheduleBounds);
  window.removeEventListener("scroll", scheduleBounds, true);
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
        <span v-if="state?.loading" class="desktop-web-view-status" :title="$t('本机页面加载中')"><LoaderCircle :size="14" class="is-spinning" /></span>
        <span v-else class="desktop-web-view-status is-local" :title="state?.autofillMessage || $t('页面由当前电脑本机直接访问')"><Laptop :size="14" /></span>
        <button type="button" :aria-label="$t('重新填充账号密码')" :title="$t('在入口原始域名的当前页面重新填充账号密码')" :disabled="!state" @click="runAction('refill')"><KeyRound :size="15" /></button>
        <button type="button" :aria-label="$t('重新登录')" :title="$t('清除本机登录状态并重新登录')" :disabled="!state || resetting" @click="resetLogin"><RotateCcw :size="15" /></button>
        <button type="button" :aria-label="focused ? $t('退出沉浸模式') : $t('进入沉浸模式')" :title="focused ? $t('退出沉浸模式') : $t('进入沉浸模式')" @click="emit('focusChange', !focused)"><Minimize2 v-if="focused" :size="15" /><Maximize2 v-else :size="15" /></button>
      </div>
    </header>
    <div ref="surface" class="web-browser-surface desktop-web-browser-surface" :class="{ 'is-preview': preview }">
      <img v-if="preview && previewFrame" :src="previewFrame" :alt="$t('{0} 的页面画面', [username])" draggable="false" />
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
.desktop-web-browser-surface.is-preview { cursor: default; }
.desktop-web-view-status { width: 28px; height: 28px; color: var(--ink-400); display: grid; place-items: center; }
.desktop-web-view-status.is-local { color: var(--teal-600); }
.web-browser-nav button:disabled, .web-browser-tools button:disabled { opacity: .34; cursor: not-allowed; }
</style>
