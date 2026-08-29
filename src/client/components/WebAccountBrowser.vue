<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCcw,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadActiveConnections } from "../active-connections";
import { api, transientApi } from "../api";
import { downloadApiFile, isDesktopApp } from "../desktop";
import { ServiceSocket } from "../service-socket";
import { normalizeWebAddress } from "../../shared/web-address";
import { historyNavigationFromMouseButton } from "../../shared/history-navigation-gesture";
import { applyHistoryNavigationCommand, applyHistoryNavigationWheel } from "../history-navigation";
import type { TlsWebEntryBadge } from "../../shared/tls-certificates";
import TlsPopover from "./credentials/TlsPopover.vue";
import WebPageTabStrip from "./WebPageTabStrip.vue";

interface BrowserPage {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

interface BrowserView {
  credentialId: string;
  entryId: string;
  entryName: string;
  entryUrl: string;
  username: string;
  url: string;
  title: string;
  activePageId: string;
  pages: BrowserPage[];
  viewport: { width: number; height: number };
}

const props = defineProps<{
  credentialId: string;
  entryId: string;
  entryName: string;
  username: string;
  entryUrl: string;
  entryTls?: TlsWebEntryBadge | null;
  relatedTlsEntries?: Array<{ id: string; name: string; url: string }>;
  externalHref: string;
  active: boolean;
  focused?: boolean;
  autoConnect?: boolean;
  preloadConnect?: boolean;
}>();
const emit = defineEmits<{
  focusChange: [focused: boolean];
  configureEntryHttps: [];
  tlsRefreshed: [];
}>();
const desktopApp = isDesktopApp();

const surface = ref<HTMLElement | null>(null);
const keyboardProxy = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const frame = ref("");
const view = ref<BrowserView | null>(null);
const address = ref(props.entryUrl);
const status = ref<"idle" | "starting" | "connecting" | "connected" | "disconnected">("idle");
const errorMessage = ref("");
const pageTabs = computed<BrowserPage[]>(() => view.value?.pages ?? []);
const activePageId = computed(() => view.value?.activePageId ?? "");
let socket: ServiceSocket | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: number | undefined;
let moveFrame: number | undefined;
let pendingMove: { x: number; y: number } | null = null;
let pendingNewPage = false;
let intentionalClose = false;
let lastViewport = { width: 960, height: 640 };
const preloading = ref(false);
let connectRequestVersion = 0;
let connectPromise: Promise<void> | null = null;
let releasePromise: Promise<void> | null = null;

function viewportSize() {
  const rect = surface.value?.getBoundingClientRect();
  if (rect && rect.width >= 2 && rect.height >= 2) {
    lastViewport = {
      width: Math.max(320, Math.min(1920, Math.round(rect.width))),
      height: Math.max(240, Math.min(1200, Math.round(rect.height))),
    };
  }
  return lastViewport;
}

function send(message: Record<string, unknown>) {
  if (socket?.readyState === ServiceSocket.OPEN) socket.send(JSON.stringify(message));
}

function syncView(next: BrowserView) {
  view.value = next;
  address.value = next.url === "about:blank" ? "" : next.url;
}

function claimPreloadedView() {
  if (!preloading.value) return;
  preloading.value = false;
  send({ type: "visibility", visible: props.active });
  resize();
}

async function releasePreloadedView() {
  if (!preloading.value) return releasePromise ?? Promise.resolve();
  if (releasePromise) return releasePromise;
  preloading.value = false;
  connectRequestVersion += 1;
  const release = (async () => {
    intentionalClose = true;
    socket?.close();
    socket = null;
    frame.value = "";
    view.value = null;
    status.value = "idle";
    errorMessage.value = "";
    pendingNewPage = false;
    const closeRequest = transientApi(`/api/v1/web-credentials/${props.credentialId}/view`, { method: "DELETE" }).catch(() => undefined);
    window.setTimeout(() => void loadActiveConnections().catch(() => undefined), 120);
    await Promise.allSettled([closeRequest, connectPromise]);
    void loadActiveConnections().catch(() => undefined);
  })();
  releasePromise = release;
  try {
    await release;
  } finally {
    if (releasePromise === release) releasePromise = null;
  }
}

async function connect(initialPage: "entry" | "blank" = "entry", preload = false) {
  await releasePromise;
  if (view.value && status.value !== "disconnected") {
    if (!preload) claimPreloadedView();
    return;
  }
  if (connectPromise) {
    if (!preload) claimPreloadedView();
    return connectPromise;
  }
  const requestVersion = ++connectRequestVersion;
  const task = (async () => {
    preloading.value = preload;
    intentionalClose = false;
    socket?.close();
    frame.value = "";
    errorMessage.value = "";
    status.value = "starting";
    await nextTick();
    try {
      const response = await transientApi<{ view: BrowserView; ticket: string; frame: string }>(`/api/v1/web-credentials/${props.credentialId}/view`, {
        method: "POST",
        body: JSON.stringify({ ...viewportSize(), initialPage, preload }),
      });
      if (requestVersion !== connectRequestVersion) return;
      syncView(response.view);
      void loadActiveConnections().catch(() => undefined);
      if (response.frame) frame.value = `data:image/jpeg;base64,${response.frame}`;
      status.value = "connecting";
      socket = new ServiceSocket("/ws/web-account-view", { ticket: response.ticket });
      socket.addEventListener("open", () => {
        send({ type: "visibility", visible: props.active && !preloading.value });
        resize();
      });
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", (event) => {
        if (intentionalClose) return;
        status.value = "disconnected";
        if (event.code !== 1000) errorMessage.value = event.reason || tr("账号页面连接已断开");
      });
      socket.addEventListener("error", () => {
        status.value = "disconnected";
        errorMessage.value = tr("账号页面连接失败");
      });
    } catch (error) {
      if (requestVersion !== connectRequestVersion) return;
      pendingNewPage = false;
      preloading.value = false;
      status.value = preload ? "idle" : "disconnected";
      errorMessage.value = preload ? "" : error instanceof Error ? error.message : tr("账号页面启动失败");
    }
  })();
  connectPromise = task;
  try {
    await task;
  } finally {
    if (connectPromise === task) connectPromise = null;
  }
}

function handleMessage(event: MessageEvent) {
  try {
    const message = JSON.parse(String(event.data)) as {
      type: string;
      data?: string;
      view?: BrowserView;
      message?: string;
      reason?: string;
      filename?: string;
      url?: string;
      dialogType?: string;
      defaultValue?: string;
    };
    if (message.type === "ready" && message.view) {
      status.value = "connected";
      syncView(message.view);
      resize();
      if (pendingNewPage) {
        pendingNewPage = false;
        send({ type: "newPage" });
      }
    } else if (message.type === "state" && message.view) {
      syncView(message.view);
    } else if (message.type === "frame" && message.data) {
      frame.value = `data:image/jpeg;base64,${message.data}`;
      status.value = "connected";
    } else if (message.type === "fileChooser") {
      fileInput.value?.click();
    } else if (message.type === "download" && message.url) {
      if (desktopApp) {
        void downloadApiFile(message.url, message.filename).then((saved) => {
          if (saved) ElMessage.success(tr("{0} 已保存", [message.filename || tr("文件")]));
        });
      } else {
        const anchor = document.createElement("a");
        anchor.href = message.url;
        anchor.download = message.filename || "download";
        anchor.click();
        ElMessage.success(tr("开始下载 {0}", [message.filename || tr("文件")]));
      }
    } else if (message.type === "autofill" && message.message) {
      ElMessage.info(message.message);
    } else if (message.type === "dialog") {
      handleDialog(message);
    } else if (message.type === "error") {
      errorMessage.value = message.message || tr("页面操作失败");
      ElMessage.error(errorMessage.value);
    } else if (message.type === "closed") {
      status.value = "disconnected";
      errorMessage.value = message.reason || tr("账号页面已休眠");
      void loadActiveConnections().catch(() => undefined);
    }
  } catch {
    errorMessage.value = tr("收到无法识别的页面消息");
  }
}

function handleDialog(message: { dialogType?: string; message?: string; defaultValue?: string }) {
  if (message.dialogType === "prompt") {
    const value = window.prompt(message.message || tr("请输入"), message.defaultValue || "");
    send({ type: "dialog", action: value === null ? "dismiss" : "accept", promptText: value || "" });
  } else if (message.dialogType === "confirm") {
    send({ type: "dialog", action: window.confirm(message.message || tr("是否继续？")) ? "accept" : "dismiss" });
  } else {
    window.alert(message.message || tr("页面提示"));
    send({ type: "dialog", action: "accept" });
  }
}

function resize() {
  if (!props.active) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => send({ type: "resize", ...viewportSize() }), 80);
}

function navigate() {
  if (status.value === "idle") return;
  const url = normalizeWebAddress(address.value);
  if (!url) {
    ElMessage.warning(tr("请输入有效的网站地址"));
    return;
  }
  address.value = url;
  send({ type: "navigate", url });
}

function focusKeyboard() {
  keyboardProxy.value?.focus({ preventScroll: true });
}

function pointerPosition(event: MouseEvent) {
  const rect = surface.value?.getBoundingClientRect();
  if (!rect) return null;
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
  };
}

function handleMouseMove(event: MouseEvent) {
  const position = pointerPosition(event);
  if (!position) return;
  pendingMove = position;
  if (moveFrame) return;
  moveFrame = window.requestAnimationFrame(() => {
    moveFrame = undefined;
    if (pendingMove) send({ type: "mouse", action: "move", ...pendingMove });
    pendingMove = null;
  });
}

function handleMouseButton(event: MouseEvent, action: "down" | "up") {
  const historyDirection = historyNavigationFromMouseButton(event.button);
  if (historyDirection) {
    if (action === "up") applyHistoryNavigationCommand(historyDirection);
    return;
  }
  const position = pointerPosition(event);
  if (!position) return;
  focusKeyboard();
  const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
  send({ type: "mouse", action, button, clickCount: event.detail || 1, ...position });
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault();
  const position = pointerPosition(event);
  if (!position) return;
  send({ type: "mouse", action: "down", button: "right", clickCount: 1, ...position });
  send({ type: "mouse", action: "up", button: "right", clickCount: 1, ...position });
}

function handleWheel(event: WheelEvent) {
  event.preventDefault();
  event.stopPropagation();
  const next = applyHistoryNavigationWheel(event, performance.now(), { ignoreBlockedTargets: true });
  if (next.status === "idle") send({ type: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
}

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (printable) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
  event.preventDefault();
  send({ type: "key", key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
}

function handleTextInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  if (target.value) send({ type: "paste", text: target.value });
  target.value = "";
}

function handlePaste(event: ClipboardEvent) {
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain");
  if (text) send({ type: "paste", text });
}

async function uploadSelectedFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const body = new FormData();
  body.append("file", file, file.name);
  try {
    await api(`/api/v1/web-credentials/${props.credentialId}/view/upload`, { method: "POST", body });
    ElMessage.success(tr("{0} 已交给页面", [file.name]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("文件上传失败"));
  }
}

async function resetLogin() {
  try {
    await ElMessageBox.confirm(tr("将清除 {0} 在此网站的 Cookie、缓存和本地存储，然后重新打开登录页。", [props.username]), tr("重新登录"), {
      type: "warning",
      confirmButtonText: tr("清除并重新登录"),
      cancelButtonText: tr("取消"),
    });
    intentionalClose = true;
    socket?.close();
    await api(`/api/v1/web-credentials/${props.credentialId}/view/reset`, { method: "POST" });
    await connect();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("重新登录失败"));
  }
}

function closePage(pageId: string) {
  if (!view.value || view.value.pages.length <= 1) return;
  send({ type: "closePage", pageId });
}

function activatePage(pageId: string) {
  if (!view.value) {
    void connect();
    return;
  }
  send({ type: "activatePage", pageId });
}

function createBlankPage() {
  if (view.value && socket?.readyState === ServiceSocket.OPEN) {
    send({ type: "newPage" });
    return;
  }
  if (status.value === "starting" || status.value === "connecting") {
    pendingNewPage = true;
    return;
  }
  void connect("blank");
}

function visitPage() {
  if (view.value) claimPreloadedView();
  else void connect();
}

function shouldIgnoreIdleSurfaceEvent(event: Event) {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest(".web-browser-idle"));
}

function handleBrowserInteraction(event: Event) {
  if (shouldIgnoreIdleSurfaceEvent(event)) return;
  claimPreloadedView();
}

function reorderPages(orderedPageIds: string[]) {
  send({ type: "reorderPages", orderedPageIds });
}

onMounted(() => {
  resizeObserver = new ResizeObserver(resize);
  if (surface.value) resizeObserver.observe(surface.value);
  if (props.autoConnect) void connect("entry", Boolean(props.preloadConnect));
});

watch(
  () => props.entryUrl,
  (entryUrl) => {
    if (status.value === "idle") address.value = entryUrl;
  },
);

watch(
  () => props.active,
  async (active) => {
    await nextTick();
    send({ type: "visibility", visible: active });
    if (active) resize();
  },
);

watch(
  [() => props.autoConnect, () => props.preloadConnect],
  ([autoConnect, preloadConnect]) => {
    if (autoConnect && status.value === "idle") void connect("entry", Boolean(preloadConnect));
    else if (!autoConnect) void releasePreloadedView();
    else if (!preloadConnect) claimPreloadedView();
  },
);

onBeforeUnmount(() => {
  if (preloading.value) void releasePreloadedView();
  else connectRequestVersion += 1;
  intentionalClose = true;
  window.clearTimeout(resizeTimer);
  if (moveFrame) window.cancelAnimationFrame(moveFrame);
  resizeObserver?.disconnect();
  socket?.close();
  window.setTimeout(() => void loadActiveConnections().catch(() => undefined), 100);
});
</script>

<template>
  <section class="web-account-browser" @pointerdown.capture="handleBrowserInteraction" @keydown.capture="handleBrowserInteraction">
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
        <button type="button" :aria-label="$t('后退')" :title="$t('后退')" :disabled="!view" @click="send({ type: 'back' })"><ArrowLeft :size="15" /></button>
        <button type="button" :aria-label="$t('前进')" :title="$t('前进')" :disabled="!view" @click="send({ type: 'forward' })"><ArrowRight :size="15" /></button>
        <button type="button" :aria-label="$t('刷新')" :title="$t('刷新')" :disabled="!view" @click="send({ type: 'reload' })"><RefreshCw :size="15" /></button>
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
        <input v-model="address" :aria-label="$t('页面地址')" autocomplete="off" spellcheck="false" :readonly="status === 'idle'" />
      </form>
      <div class="web-browser-tools">
        <button type="button" :aria-label="$t('新建空白标签页')" :title="$t('新建空白标签页')" @click="createBlankPage"><Plus :size="15" /></button>
        <button type="button" :aria-label="$t('重新填充账号密码')" :title="$t('重新填充账号密码')" :disabled="!view" @click="send({ type: 'refill' })"><KeyRound :size="15" /></button>
        <button type="button" :aria-label="$t('重新登录')" :title="$t('清除登录状态并重新登录')" :disabled="!view" @click="resetLogin"><RotateCcw :size="15" /></button>
        <button v-if="focused !== undefined" type="button" :aria-label="focused ? $t('退出沉浸模式') : $t('进入沉浸模式')" :title="focused ? $t('退出沉浸模式') : $t('进入沉浸模式')" @click="emit('focusChange', !focused)"><Minimize2 v-if="focused" :size="15" /><Maximize2 v-else :size="15" /></button>
        <a v-if="!desktopApp" :href="externalHref" target="_blank" rel="noopener noreferrer" :aria-label="$t('在浏览器新标签页打开')" :title="$t('在浏览器新标签页打开')"><ExternalLink :size="15" /></a>
      </div>
    </header>

    <div
      ref="surface"
      class="web-browser-surface"
      @mousemove="handleMouseMove"
      @mousedown.prevent="handleMouseButton($event, 'down')"
      @mouseup.prevent="handleMouseButton($event, 'up')"
      @contextmenu="handleContextMenu"
      @wheel="handleWheel"
    >
      <img v-if="frame" :src="frame" :alt="$t('{0} 的页面画面', [username])" draggable="false" />
      <div v-else-if="status === 'idle' || preloading" class="web-browser-loading web-browser-idle" :title="$t('双击空白处访问页面')" @pointerdown.stop @mousedown.stop @dblclick="visitPage">
        <div class="web-browser-idle__icon"><Globe2 :size="24" /></div>
        <strong>{{ $t('准备访问此页面') }}</strong>
        <span>{{ $t('双击空白处或点击下方按钮，将建立 Web 连接并加载上方地址。') }}</span>
        <button type="button" @click.stop="visitPage"><Globe2 :size="15" />{{ $t('访问页面') }}</button>
      </div>
      <div v-else class="web-browser-loading">
        <LoaderCircle :size="25" class="is-spinning" />
        <strong>{{ status === 'disconnected' ? $t('页面暂时不可用') : $t('正在启动账号页面') }}</strong>
        <span>{{ errorMessage || $t('首次打开需要启动独立 Chrome 内核') }}</span>
        <button v-if="status === 'disconnected'" type="button" @click="connect()">{{ $t('重新连接') }}</button>
      </div>
      <textarea
        ref="keyboardProxy"
        class="web-browser-keyboard-proxy"
        :aria-label="$t('账号页面键盘输入')"
        @keydown="handleKeydown"
        @input="handleTextInput"
        @paste="handlePaste"
      ></textarea>
      <input ref="fileInput" type="file" hidden @change="uploadSelectedFile" />
    </div>
  </section>
</template>
