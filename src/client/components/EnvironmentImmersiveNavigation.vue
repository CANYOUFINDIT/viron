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
  MemoryStick,
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
const hoverCollapseDelay = 80;
let dragStart: { x: number; y: number } | null = null;
let dragging = false;
let hoverCollapseTimer: number | null = null;
let stopNativeActions: (() => void) | null = null;
let themeObserver: MutationObserver | null = null;
const dark = ref(document.documentElement.classList.contains("dark"));

const selectedPath = computed(() => {
  if (props.activeTab !== "web") return props.activeTab;
  return `${props.selectedEntryId}:${props.selectedCredentialId}`;
});

const hiddenFavicons = ref(new Set<string>());

const currentRow = computed(() => {
  if (props.activeTab !== "web") return { kind: "module" as const, id: props.activeTab };
  const accountVisible = webExpanded.value && expandedEntryId.value === props.selectedEntryId && Boolean(props.selectedCredentialId);
  if (accountVisible) return { kind: "account" as const, entryId: props.selectedEntryId, id: props.selectedCredentialId };
  if (webExpanded.value && props.selectedEntryId) return { kind: "entry" as const, id: props.selectedEntryId };
  return { kind: "web" as const };
});

function entryFavicon(entry: ImmersiveNavigationEntry): string {
  const value = entry.faviconDataUrl;
  if (!value || hiddenFavicons.value.has(entry.id) || !value.startsWith("data:image/")) return "";
  return value;
}

function hideFavicon(entryId: string) {
  hiddenFavicons.value = new Set(hiddenFavicons.value).add(entryId);
}

function entryIsCurrent(entryId: string) {
  return currentRow.value.kind === "entry" && currentRow.value.id === entryId;
}

function accountIsCurrent(entryId: string, credentialId: string) {
  const current = currentRow.value;
  return current.kind === "account" && current.entryId === entryId && current.id === credentialId;
}

function moduleIsCurrent(tab: Exclude<ImmersiveWorkspaceTab, "web">) {
  return currentRow.value.kind === "module" && currentRow.value.id === tab;
}

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

function clearHoverCollapse() {
  if (hoverCollapseTimer === null) return;
  window.clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = null;
}

function onNavigationPointerEnter(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  clearHoverCollapse();
}

function onNavigationPointerLeave(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
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
        <div class="immersive-navigation-surface">
          <header>
            <div class="immersive-navigation-heading">
              <span>IMMERSIVE WORKSPACE</span>
              <strong>{{ environmentName }}</strong>
            </div>
            <button class="immersive-panel-collapse" type="button" :aria-label="$t('收起环境导航')" :title="$t('收起环境导航')" @click="collapse">
              <ChevronLeft v-if="dock.edge === 'left'" :size="18" />
              <ChevronRight v-else-if="dock.edge === 'right'" :size="18" />
              <ChevronUp v-else :size="18" />
            </button>
          </header>

          <nav class="immersive-navigation-tree">
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': currentRow.kind === 'web' }" type="button" :aria-expanded="webExpanded" @click="toggleWeb">
              <span class="immersive-tree-icon"><Globe2 :size="17" /></span><span>{{ $t('Web 入口') }}</span><small>{{ counts.web }}</small><i class="immersive-twisty" :class="{ 'is-open': webExpanded }"></i>
            </button>
            <template v-if="webExpanded">
              <div v-for="entry in entries" :key="entry.id" class="immersive-limb" :class="{ 'is-open': expandedEntryId === entry.id }">
                <button class="immersive-tree-row is-level-2" :class="{ 'is-current': entryIsCurrent(entry.id) }" type="button" :aria-expanded="expandedEntryId === entry.id" @click="toggleEntry(entry.id)">
                  <span class="immersive-tree-icon"><img v-if="entryFavicon(entry)" :src="entryFavicon(entry)" alt="" @error="hideFavicon(entry.id)" /><Globe2 v-else :size="17" /></span><span>{{ entry.name }}</span><small>{{ entry.credentialCount }}</small><i class="immersive-twisty" :class="{ 'is-open': expandedEntryId === entry.id }"></i>
                </button>
                <div v-if="expandedEntryId === entry.id" class="immersive-limb-kids">
                  <span v-if="entry.loading" class="immersive-tree-empty">{{ $t('正在读取登录账号…') }}</span>
                  <button
                    v-for="credential in entry.credentials || []"
                    :key="credential.id"
                    class="immersive-tree-row is-level-3"
                    :class="{ 'is-current': accountIsCurrent(entry.id, credential.id) }"
                    type="button"
                    @click="selectCredential(entry.id, credential.id)"
                  >
                    <span>{{ credential.username }}</span><i v-if="accountIsCurrent(entry.id, credential.id)" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span>
                  </button>
                  <span v-if="!entry.loading && entry.credentials && !entry.credentials.length" class="immersive-tree-empty">{{ $t('暂无登录账号') }}</span>
                </div>
              </div>
              <span v-if="!entries.length" class="immersive-tree-empty">{{ $t('暂无 Web 入口') }}</span>
            </template>

            <div class="immersive-split">{{ $t('工作台') }}</div>
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': moduleIsCurrent('ssh') }" type="button" @click="selectTab('ssh')"><span class="immersive-tree-icon"><TerminalSquare :size="17" /></span><span>{{ $t('SSH 终端') }}</span><small>{{ counts.ssh }}</small><i v-if="moduleIsCurrent('ssh')" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span></button>
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': moduleIsCurrent('logs') }" type="button" @click="selectTab('logs')"><span class="immersive-tree-icon"><FileText :size="17" /></span><span>{{ $t('日志') }}</span><small>{{ counts.logs }}</small><i v-if="moduleIsCurrent('logs')" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span></button>
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': moduleIsCurrent('database') }" type="button" @click="selectTab('database')"><span class="immersive-tree-icon"><Database :size="17" /></span><span>{{ $t('数据库') }}</span><small>{{ counts.database }}</small><i v-if="moduleIsCurrent('database')" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span></button>
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': moduleIsCurrent('redis') }" type="button" @click="selectTab('redis')"><span class="immersive-tree-icon"><MemoryStick :size="17" /></span><span>Redis</span><small>{{ counts.redis }}</small><i v-if="moduleIsCurrent('redis')" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span></button>
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': moduleIsCurrent('knowledge') }" type="button" @click="selectTab('knowledge')"><span class="immersive-tree-icon"><BookOpen :size="17" /></span><span>{{ $t('知识库') }}</span><small>{{ counts.knowledge }}</small><i v-if="moduleIsCurrent('knowledge')" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span></button>
            <button class="immersive-tree-row is-level-1" :class="{ 'is-current': moduleIsCurrent('maintenance') }" type="button" @click="selectTab('maintenance')"><span class="immersive-tree-icon"><Wrench :size="17" /></span><span>{{ $t('服务维护') }}</span><small>{{ $t('服务') }} {{ counts.maintenance }} · {{ $t('主机') }} {{ maintenanceHostCount }}</small><i v-if="moduleIsCurrent('maintenance')" class="immersive-check"></i><span v-else class="immersive-twistyslot"></span></button>
          </nav>

          <footer><button type="button" @click="exit"><i class="immersive-exit-arrow"></i>{{ $t('退出沉浸模式') }}</button></footer>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.environment-immersive-navigation { position: fixed; z-index: 120; color: var(--ink-900); transition: left .22s cubic-bezier(.22, 1, .36, 1), top .22s cubic-bezier(.22, 1, .36, 1), width .22s cubic-bezier(.22, 1, .36, 1), height .22s cubic-bezier(.22, 1, .36, 1); }
.environment-immersive-navigation.is-dragging { transition: none; }
.immersive-edge-handle { width: 100%; height: 100%; padding: 0; border: 0; background: var(--teal-600); color: white; display: grid; place-items: center; cursor: pointer; touch-action: none; box-shadow: 0 5px 14px color-mix(in srgb, var(--teal-700) 32%, transparent); transition: background-color .12s ease; }
.immersive-edge-handle:hover { background: var(--teal-700); }
.immersive-edge-handle:active { background: #105f52; }
.immersive-edge-handle:focus-visible { outline: 2px solid var(--teal-100); outline-offset: -3px; }
:global(:root.dark) .immersive-edge-handle:hover { background: var(--teal-500); }
:global(:root.dark) .immersive-edge-handle:active { background: var(--teal-700); }
:global(:root.dark) .immersive-edge-handle:focus-visible { outline-color: #68cfad; }
.is-left .immersive-edge-handle { border-radius: 0 11px 11px 0; }
.is-right .immersive-edge-handle { border-radius: 11px 0 0 11px; }
.is-top .immersive-edge-handle { border-radius: 0 0 11px 11px; }
.immersive-navigation-panel { position: relative; width: 100%; height: 100%; filter: drop-shadow(0 20px 27px rgba(8, 22, 25, .18)) drop-shadow(0 3px 6px rgba(8, 22, 25, .12)); overflow: visible; outline: 0; }
.immersive-navigation-surface { --nav-bg: #fbfcfb; --nav-ink: #1c2927; --nav-muted: #5c6e6a; --nav-faint: #6b7d79; --nav-line: #e1e8e5; --nav-hover: rgba(18, 36, 32, .05); --nav-accent: #0f6b58; --nav-accent-bg: #e5f3ee; --nav-accent-ink: #0d4f42; --nav-edge: rgba(20, 40, 36, .12); width: 100%; height: 100%; background: var(--nav-bg); color: var(--nav-ink); box-shadow: inset 0 0 0 1px var(--nav-edge); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; isolation: isolate; }
:global(:root.dark) .immersive-navigation-surface { --nav-bg: #171d1f; --nav-ink: #e8efed; --nav-muted: #9aa7a4; --nav-faint: #8d9c99; --nav-line: rgba(255, 255, 255, .1); --nav-hover: rgba(255, 255, 255, .055); --nav-accent: #8fd0c0; --nav-accent-bg: #1c4038; --nav-accent-ink: #e9f8f3; --nav-edge: rgba(255, 255, 255, .1); }
.is-left .immersive-navigation-surface { border-radius: 0 15px 15px 0; clip-path: inset(0 round 0 15px 15px 0); }
.is-right .immersive-navigation-surface { border-radius: 15px 0 0 15px; clip-path: inset(0 round 15px 0 0 15px); }
.is-top .immersive-navigation-surface { border-radius: 0 0 15px 15px; clip-path: inset(0 round 0 0 15px 15px); }
.immersive-navigation-surface > header { min-height: 72px; padding: 14px 12px 12px 16px; border-bottom: 1px solid var(--nav-line); background: transparent; display: grid; grid-template-columns: minmax(0, 1fr) 32px; align-items: center; gap: 10px; }
.immersive-navigation-heading { min-width: 0; }
.immersive-navigation-heading span, .immersive-navigation-heading strong { display: block; }
.immersive-navigation-heading span { color: var(--nav-faint); font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .14em; }
.immersive-navigation-heading strong { margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 650; }
.immersive-panel-collapse { width: 32px; height: 32px; padding: 0; border: 1px solid var(--nav-line); border-radius: 9px; background: transparent; color: var(--nav-muted); display: grid; place-items: center; cursor: pointer; }
.immersive-panel-collapse:hover { background: var(--nav-hover); color: var(--nav-ink); }
.immersive-panel-collapse:focus-visible, .immersive-tree-row:focus-visible, .immersive-navigation-surface > footer button:focus-visible { outline: 2px solid var(--nav-accent); outline-offset: -2px; }
.immersive-navigation-tree { min-height: 0; padding: 8px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(138, 156, 152, .7) transparent; display: flex; flex-direction: column; gap: 2px; }
.immersive-tree-row { width: 100%; min-width: 0; min-height: 36px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--nav-ink); display: grid; grid-template-columns: minmax(0, 1fr) 14px; align-items: center; gap: 6px; text-align: left; cursor: pointer; }
.immersive-tree-row.is-level-1, .immersive-tree-row.is-level-2 { grid-template-columns: 18px minmax(0, 1fr) auto 14px; }
.immersive-tree-row.is-level-1 { min-height: 40px; }
.immersive-tree-row.is-level-2 { min-height: 36px; }
.immersive-tree-row.is-level-3 { min-height: 32px; }
.immersive-tree-row:hover:not(.is-current) { background: var(--nav-hover); }
.immersive-tree-row.is-current { background: var(--nav-accent-bg); color: var(--nav-accent-ink); font-weight: 700; }
.immersive-tree-icon { width: 18px; height: 18px; display: grid; place-items: center; }
.immersive-tree-icon svg { width: 17px; height: 17px; display: block; }
.immersive-tree-icon img { width: 16px; height: 16px; display: block; object-fit: contain; }
.immersive-tree-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 650; }
.immersive-tree-row.is-level-3 > span { font-size: 12px; font-weight: 600; }
.immersive-tree-row.is-current > span { font-weight: inherit; }
.immersive-tree-row small { color: var(--nav-faint); white-space: nowrap; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.immersive-tree-row.is-current small, .immersive-tree-row.is-current .immersive-tree-icon, .immersive-tree-row.is-current .immersive-twisty, .immersive-tree-row.is-current .immersive-check { color: inherit; border-color: currentColor; }
.immersive-twisty, .immersive-check, .immersive-exit-arrow { display: block; box-sizing: border-box; }
.immersive-twisty { width: 7px; height: 7px; margin-left: 3px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); }
.immersive-twisty.is-open { transform: rotate(45deg); }
.immersive-twistyslot { width: 14px; height: 14px; }
.immersive-check { width: 11px; height: 6px; margin-bottom: 3px; border-left: 1.8px solid var(--nav-accent); border-bottom: 1.8px solid var(--nav-accent); transform: rotate(-45deg); }
.immersive-limb, .immersive-limb-kids { display: flex; flex-direction: column; gap: 1px; }
.immersive-limb.is-open { margin-bottom: 4px; }
.immersive-limb-kids .immersive-tree-row.is-level-3, .immersive-tree-empty { width: calc(100% - 32px); margin-left: 32px; }
.immersive-tree-empty { min-height: 32px; padding: 6px 8px; color: var(--nav-faint); display: flex; align-items: center; font-size: 12px; }
.immersive-split { margin: 8px 4px 2px; padding: 10px 8px 4px; border-top: 1px solid var(--nav-line); color: var(--nav-faint); font-size: 11px; font-weight: 650; }
.immersive-exit-arrow { width: 7px; height: 7px; border-left: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); }
.immersive-navigation-surface > footer { padding: 8px; border-top: 1px solid var(--nav-line); }
.immersive-navigation-surface > footer button { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--nav-line); border-radius: 8px; background: transparent; color: var(--nav-ink); display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; font-size: 12px; font-weight: 700; }
.immersive-navigation-surface > footer button:hover { background: var(--nav-hover); }
@media (prefers-reduced-motion: reduce) { .environment-immersive-navigation, .immersive-edge-handle, .immersive-twisty { transition: none; } }
</style>
