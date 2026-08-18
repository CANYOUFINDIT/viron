<script setup lang="ts">
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  BookOpen,
  Database,
  FileText,
  Globe2,
  KeyRound,
  MemoryStick,
  LogOut,
  TerminalSquare,
  Wrench,
} from "@lucide/vue";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, watchEffect } from "vue";
import {
  defaultImmersiveDock,
  immersiveNavigationBounds,
  immersiveNavigationSize,
  snapImmersiveDock,
  type ImmersiveDockPosition,
  type ImmersiveNavigationAction,
  type ImmersiveNavigationEntry,
  type ImmersiveNavigationState,
  type ImmersiveWorkspaceTab,
} from "../../shared/immersive-navigation";
import {
  onDesktopImmersiveNavigationAction,
  updateDesktopImmersiveNavigation,
} from "../desktop";
import { language } from "../i18n";

const props = defineProps<{
  native: boolean;
  environmentName: string;
  activeTab: ImmersiveWorkspaceTab;
  selectedEntryId: string;
  selectedCredentialId: string;
  counts: Record<ImmersiveWorkspaceTab, number>;
  maintenanceHostCount: number;
  entries: ImmersiveNavigationEntry[];
}>();

const emit = defineEmits<{
  selectTab: [tab: Exclude<ImmersiveWorkspaceTab, "web">];
  selectCredential: [entryId: string, credentialId: string];
  loadCredentials: [entryId: string];
  exit: [];
}>();

const panel = ref<HTMLElement | null>(null);
const handle = ref<HTMLElement | null>(null);
const expanded = ref(false);
const webExpanded = ref(props.activeTab === "web");
const expandedEntryId = ref(props.activeTab === "web" ? props.selectedEntryId : "");
const dock = ref<ImmersiveDockPosition>(defaultImmersiveDock());
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });
const dragPoint = ref<{ x: number; y: number } | null>(null);
const hoverOpenDelay = 120;
const hoverCollapseDelay = 80;
let dragStart: { x: number; y: number } | null = null;
let dragging = false;
let hoverOpenTimer: number | null = null;
let hoverCollapseTimer: number | null = null;
let stopNativeActions: (() => void) | null = null;
let themeObserver: MutationObserver | null = null;
const dark = ref(document.documentElement.classList.contains("dark"));

const selectedPath = computed(() => {
  if (props.activeTab !== "web") return props.activeTab;
  return `${props.selectedEntryId}:${props.selectedCredentialId}`;
});

const navigationState = computed<ImmersiveNavigationState>(() => ({
  language: language.value,
  visible: true,
  expanded: expanded.value,
  dark: dark.value,
  dock: dock.value,
  environmentName: props.environmentName,
  activeTab: props.activeTab,
  webExpanded: webExpanded.value,
  expandedEntryId: expandedEntryId.value,
  selectedEntryId: props.selectedEntryId,
  selectedCredentialId: props.selectedCredentialId,
  counts: props.counts,
  maintenanceHostCount: props.maintenanceHostCount,
  entries: props.entries,
}));

const shellStyle = computed(() => {
  if (dragPoint.value) {
    const size = dock.value.edge === "top" ? { width: 48, height: 34 } : { width: 34, height: 48 };
    return {
      left: `${dragPoint.value.x - size.width / 2}px`,
      top: `${dragPoint.value.y - size.height / 2}px`,
      width: `${size.width}px`,
      height: `${size.height}px`,
    };
  }
  const area = { x: 0, y: 0, width: viewport.value.width, height: viewport.value.height };
  const size = immersiveNavigationSize(dock.value, expanded.value, area);
  const bounds = immersiveNavigationBounds(dock.value, size, area);
  return {
    left: `${bounds.x}px`,
    top: `${bounds.y}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  };
});

function open() {
  webExpanded.value = props.activeTab === "web";
  expandedEntryId.value = props.activeTab === "web" ? props.selectedEntryId : "";
  if (expandedEntryId.value) emit("loadCredentials", expandedEntryId.value);
  expanded.value = true;
}

function collapse() {
  expanded.value = false;
}

function clearHoverOpen() {
  if (hoverOpenTimer === null) return;
  window.clearTimeout(hoverOpenTimer);
  hoverOpenTimer = null;
}

function clearHoverCollapse() {
  if (hoverCollapseTimer === null) return;
  window.clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = null;
}

function onNavigationPointerEnter(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  clearHoverCollapse();
  if (expanded.value || dragStart || hoverOpenTimer !== null) return;
  hoverOpenTimer = window.setTimeout(() => {
    hoverOpenTimer = null;
    if (!expanded.value && !dragStart) open();
  }, hoverOpenDelay);
}

function onNavigationPointerLeave(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  clearHoverOpen();
  if (!expanded.value || hoverCollapseTimer !== null) return;
  hoverCollapseTimer = window.setTimeout(() => {
    hoverCollapseTimer = null;
    if (expanded.value) collapse();
  }, hoverCollapseDelay);
}

function toggleWeb() {
  webExpanded.value = !webExpanded.value;
}

function toggleEntry(entryId: string) {
  const opening = expandedEntryId.value !== entryId;
  expandedEntryId.value = opening ? entryId : "";
  if (opening) emit("loadCredentials", entryId);
}

function selectTab(tab: Exclude<ImmersiveWorkspaceTab, "web">) {
  emit("selectTab", tab);
  collapse();
}

function selectCredential(entryId: string, credentialId: string) {
  emit("selectCredential", entryId, credentialId);
  collapse();
}

function exit() {
  collapse();
  emit("exit");
}

function handleNativeAction(action: ImmersiveNavigationAction) {
  if (action.type === "toggle") expanded.value ? collapse() : open();
  else if (action.type === "collapse") collapse();
  else if (action.type === "toggle-web") toggleWeb();
  else if (action.type === "toggle-entry") toggleEntry(action.entryId);
  else if (action.type === "select-tab") selectTab(action.tab);
  else if (action.type === "select-credential") selectCredential(action.entryId, action.credentialId);
  else if (action.type === "exit") exit();
  else if (action.type === "dock") dock.value = action.dock;
}

function onPointerDown(event: PointerEvent) {
  if (expanded.value || event.button !== 0) return;
  clearHoverOpen();
  dragStart = { x: event.clientX, y: event.clientY };
  dragging = false;
  handle.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!dragStart || expanded.value) return;
  if (!dragging && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) < 5) return;
  dragging = true;
  dragPoint.value = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  if (!dragStart || expanded.value) return;
  handle.value?.releasePointerCapture(event.pointerId);
  if (dragging) {
    dock.value = snapImmersiveDock(
      { x: event.clientX, y: event.clientY },
      { x: 0, y: 0, width: viewport.value.width, height: viewport.value.height },
    );
  } else open();
  dragStart = null;
  dragging = false;
  dragPoint.value = null;
}

function onPointerCancel(event: PointerEvent) {
  handle.value?.releasePointerCapture(event.pointerId);
  dragStart = null;
  dragging = false;
  dragPoint.value = null;
}

function onHandleClick(event: MouseEvent) {
  if (event.detail === 0) open();
}

function onOutsidePointerDown(event: PointerEvent) {
  if (!expanded.value || panel.value?.contains(event.target as Node)) return;
  collapse();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !expanded.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  collapse();
}

function onResize() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight };
}

watch(selectedPath, () => {
  if (!expanded.value || props.activeTab !== "web") return;
  webExpanded.value = true;
  expandedEntryId.value = props.selectedEntryId;
});

watchEffect(() => {
  if (!props.native) return;
  void updateDesktopImmersiveNavigation(navigationState.value).catch(() => undefined);
});

onActivated(() => {
  if (props.native) void updateDesktopImmersiveNavigation(navigationState.value).catch(() => undefined);
});

onDeactivated(() => {
  if (props.native) void updateDesktopImmersiveNavigation(null).catch(() => undefined);
});

onMounted(() => {
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onResize);
  themeObserver = new MutationObserver(() => { dark.value = document.documentElement.classList.contains("dark"); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  if (props.native) stopNativeActions = onDesktopImmersiveNavigationAction(handleNativeAction);
});

onBeforeUnmount(() => {
  clearHoverOpen();
  clearHoverCollapse();
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", onResize);
  themeObserver?.disconnect();
  stopNativeActions?.();
  if (props.native) void updateDesktopImmersiveNavigation(null).catch(() => undefined);
});

async function focusPanel() {
  await nextTick();
  panel.value?.focus({ preventScroll: true });
}

watch(expanded, (value) => { if (value && !props.native) void focusPanel(); });
</script>

<template>
  <Teleport v-if="!native" to="body">
    <div
      class="environment-immersive-navigation"
      :class="[`is-${dock.edge}`, { 'is-expanded': expanded, 'is-dragging': dragPoint }]"
      :style="shellStyle"
      @pointerenter="onNavigationPointerEnter"
      @pointerleave="onNavigationPointerLeave"
    >
      <button
        v-if="!expanded"
        ref="handle"
        class="immersive-edge-handle"
        type="button"
        :aria-label="$t('展开环境导航')"
        :title="$t('展开环境导航')"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @click="onHandleClick"
      >
        <ChevronRight v-if="dock.edge === 'left'" :size="21" />
        <ChevronLeft v-else-if="dock.edge === 'right'" :size="21" />
        <ChevronDown v-else :size="21" />
      </button>

      <section v-else ref="panel" class="immersive-navigation-panel" tabindex="-1" :aria-label="$t('环境沉浸导航')">
        <button class="immersive-panel-collapse" type="button" :aria-label="$t('收起环境导航')" @click="collapse">
          <ChevronLeft v-if="dock.edge === 'left'" :size="19" />
          <ChevronRight v-else-if="dock.edge === 'right'" :size="19" />
          <ChevronUp v-else :size="19" />
        </button>
        <header>
          <span>IMMERSIVE WORKSPACE</span>
          <strong>{{ environmentName }}</strong>
        </header>

        <nav class="immersive-navigation-tree">
          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'web' }" type="button" @click="toggleWeb">
            <Globe2 :size="16" /><span>{{ $t('Web 入口') }}</span><small>{{ counts.web }}</small><ChevronDown :size="14" :class="{ 'is-collapsed': !webExpanded }" />
          </button>
          <div v-if="webExpanded" class="immersive-tree-branch is-web-branch">
            <template v-for="entry in entries" :key="entry.id">
              <button class="immersive-tree-row is-level-2" :class="{ 'is-active': selectedEntryId === entry.id }" type="button" @click="toggleEntry(entry.id)">
                <span class="immersive-tree-dot"></span><span>{{ entry.name }}</span><small>{{ entry.credentialCount }}</small><ChevronDown :size="13" :class="{ 'is-collapsed': expandedEntryId !== entry.id }" />
              </button>
              <div v-if="expandedEntryId === entry.id" class="immersive-tree-branch is-account-branch">
                <span v-if="entry.loading" class="immersive-tree-empty">{{ $t('正在读取登录账号…') }}</span>
                <button
                  v-for="credential in entry.credentials || []"
                  :key="credential.id"
                  class="immersive-tree-row is-level-3"
                  :class="{ 'is-active': activeTab === 'web' && selectedEntryId === entry.id && selectedCredentialId === credential.id }"
                  type="button"
                  @click="selectCredential(entry.id, credential.id)"
                >
                  <KeyRound :size="13" /><span>{{ credential.username }}</span>
                </button>
                <span v-if="!entry.loading && entry.credentials && !entry.credentials.length" class="immersive-tree-empty">{{ $t('暂无登录账号') }}</span>
              </div>
            </template>
            <span v-if="!entries.length" class="immersive-tree-empty">{{ $t('暂无 Web 入口') }}</span>
          </div>

          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'ssh' }" type="button" @click="selectTab('ssh')"><TerminalSquare :size="16" /><span>{{ $t('SSH 终端') }}</span><small>{{ counts.ssh }}</small></button>
          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'logs' }" type="button" @click="selectTab('logs')"><FileText :size="16" /><span>{{ $t('日志') }}</span><small>{{ counts.logs }}</small></button>
          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'database' }" type="button" @click="selectTab('database')"><Database :size="16" /><span>{{ $t('数据库') }}</span><small>{{ counts.database }}</small></button>
          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'redis' }" type="button" @click="selectTab('redis')"><MemoryStick :size="16" /><span>Redis</span><small>{{ counts.redis }}</small></button>
          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'knowledge' }" type="button" @click="selectTab('knowledge')"><BookOpen :size="16" /><span>{{ $t('知识库') }}</span><small>{{ counts.knowledge }}</small></button>
          <button class="immersive-tree-row is-level-1" :class="{ 'is-active': activeTab === 'maintenance' }" type="button" @click="selectTab('maintenance')"><Wrench :size="16" /><span>{{ $t('服务维护') }}</span><small class="maintenance-count">{{ $t('服务') }} {{ counts.maintenance }} · {{ $t('主机') }} {{ maintenanceHostCount }}</small></button>
        </nav>

        <footer><button type="button" @click="exit"><LogOut :size="15" />{{ $t('退出沉浸模式') }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.environment-immersive-navigation { position: fixed; z-index: 120; color: var(--ink-900); transition: left .22s cubic-bezier(.22, 1, .36, 1), top .22s cubic-bezier(.22, 1, .36, 1), width .22s cubic-bezier(.22, 1, .36, 1), height .22s cubic-bezier(.22, 1, .36, 1); }
.environment-immersive-navigation.is-dragging { transition: none; }
.immersive-edge-handle, .immersive-panel-collapse { padding: 0; border: 0; background: #5d9ad6; color: white; display: grid; place-items: center; cursor: pointer; box-shadow: 0 5px 14px rgba(18, 67, 112, .28); }
.immersive-edge-handle { width: 100%; height: 100%; touch-action: none; }
.is-left .immersive-edge-handle { border-radius: 0 11px 11px 0; }
.is-right .immersive-edge-handle { border-radius: 11px 0 0 11px; }
.is-top .immersive-edge-handle { border-radius: 0 0 11px 11px; }
.immersive-navigation-panel { position: relative; width: 100%; height: 100%; border: 1px solid color-mix(in srgb, var(--ink-200) 82%, transparent); background: color-mix(in srgb, var(--surface) 97%, transparent); box-shadow: 0 20px 54px rgba(8, 22, 25, .22), 0 3px 12px rgba(8, 22, 25, .12); backdrop-filter: blur(18px); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: visible; outline: 0; }
.is-left .immersive-navigation-panel { border-radius: 0 15px 15px 0; }
.is-right .immersive-navigation-panel { border-radius: 15px 0 0 15px; }
.is-top .immersive-navigation-panel { border-radius: 0 0 15px 15px; }
.immersive-panel-collapse { position: absolute; z-index: 2; width: 28px; height: 42px; }
.is-left .immersive-panel-collapse { right: -28px; top: 32px; border-radius: 0 9px 9px 0; }
.is-right .immersive-panel-collapse { left: -28px; top: 32px; border-radius: 9px 0 0 9px; }
.is-top .immersive-panel-collapse { left: 32px; bottom: -28px; width: 42px; height: 28px; border-radius: 0 0 9px 9px; }
.immersive-navigation-panel > header { min-height: 72px; padding: 17px 18px 14px; border-bottom: 1px solid var(--ink-100); background: linear-gradient(135deg, color-mix(in srgb, var(--teal-50) 74%, var(--surface)), var(--surface)); }
.is-left .immersive-navigation-panel > header { border-radius: 0 14px 0 0; }
.is-right .immersive-navigation-panel > header { border-radius: 14px 0 0 0; }
.immersive-navigation-panel > header span, .immersive-navigation-panel > header strong { display: block; }
.immersive-navigation-panel > header span { color: var(--teal-600); font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: .16em; }
.immersive-navigation-panel > header strong { margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.immersive-navigation-tree { min-height: 0; padding: 10px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--ink-200) transparent; }
.immersive-tree-row { width: 100%; min-width: 0; min-height: 36px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--ink-600); display: grid; grid-template-columns: 18px minmax(0, 1fr) auto auto; align-items: center; gap: 7px; text-align: left; cursor: pointer; }
.immersive-tree-row:hover { background: var(--ink-50); color: var(--ink-800); }
.immersive-tree-row.is-active { background: var(--teal-50); color: var(--teal-700); }
.immersive-tree-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 700; }
.immersive-tree-row small { min-width: 20px; height: 19px; padding: 0 5px; border-radius: 10px; background: var(--ink-100); color: var(--ink-500); display: grid; place-items: center; font-size: 10px; }
.immersive-tree-row small.maintenance-count { width: auto; white-space: nowrap; }
.immersive-tree-row > svg:last-child { transition: transform .16s ease; }
.immersive-tree-row > svg:last-child.is-collapsed { transform: rotate(-90deg); }
.immersive-tree-branch { position: relative; }
.is-web-branch::before, .is-account-branch::before { content: ""; position: absolute; top: 0; bottom: 4px; width: 1px; background: var(--ink-100); }
.is-web-branch::before { left: 18px; }
.is-account-branch::before { left: 31px; }
.immersive-tree-row.is-level-2 { padding-left: 14px; grid-template-columns: 12px minmax(0, 1fr) auto auto; }
.immersive-tree-dot { width: 6px; height: 6px; margin-left: 1px; border: 1px solid var(--teal-500); border-radius: 50%; background: var(--surface); }
.immersive-tree-row.is-level-3 { min-height: 32px; padding-left: 28px; grid-template-columns: 15px minmax(0, 1fr); }
.immersive-tree-row.is-level-3 span { font-size: 11px; font-weight: 650; }
.immersive-tree-empty { min-height: 31px; padding: 7px 10px 7px 43px; color: var(--ink-400); display: flex; align-items: center; font-size: 10px; }
.immersive-navigation-panel > footer { padding: 10px; border-top: 1px solid var(--ink-100); }
.is-left .immersive-navigation-panel > footer { border-radius: 0 0 14px 0; }
.is-right .immersive-navigation-panel > footer { border-radius: 0 0 0 14px; }
.is-top .immersive-navigation-panel > footer { border-radius: 0 0 14px 14px; }
.immersive-navigation-panel > footer button { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--ink-100); border-radius: 7px; background: var(--surface); color: var(--ink-500); display: flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer; font-size: 11px; font-weight: 700; }
.immersive-navigation-panel > footer button:hover { border-color: var(--red-100); background: var(--red-100); color: var(--red-600); }
@media (prefers-reduced-motion: reduce) { .environment-immersive-navigation, .immersive-tree-row > svg:last-child { transition: none; } }
</style>
