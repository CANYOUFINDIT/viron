<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  Boxes,
  BookOpen,
  Building2,
  Check,
  ChevronsUpDown,
  CircleGauge,
  ClipboardList,
  Database,
  Download,
  KeyRound,
  MemoryStick,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  TerminalSquare,
  UserRound,
  Users,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, provide, readonly, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isDesktopApp } from "../desktop";
import { initializeAppShortcuts, onAppShortcut, shortcutActionFromKeyboardEvent } from "../keyboard-shortcuts";
import { environmentOverviewNavigationTarget, updateRememberedEnvironmentId } from "../environment-overview-navigation";
import { session, switchWorkspace } from "../session";
import { activeConnections, loadActiveConnections } from "../active-connections";
import { immersiveModeKey } from "../immersive-mode";
import { agentNativeOverlayActive } from "../agent-host";
import { installHistoryNavigationGestures } from "../history-navigation";
import { installVisitHistory, visitHistoryCanNavigate, visitHistoryNavigate } from "../visit-history";
import AgentFloatingWindow from "./AgentFloatingWindow.vue";
import HistoryNavigationOverlay from "./HistoryNavigationOverlay.vue";
import AgentHostBridge from "./AgentHostBridge.vue";
import ActiveEnvironmentDockWindow from "./ActiveEnvironmentDockWindow.vue";
import ConnectionQualityWindow from "./ConnectionQualityWindow.vue";
import MonitorAlertCenter from "./MonitorAlertCenter.vue";
import vironLogoUrl from "../../../design/logo/viron-logo.svg?url";

const route = useRoute();
const router = useRouter();
const desktop = isDesktopApp();
const macosDesktop = desktop && /Macintosh|Mac OS X/.test(navigator.userAgent);
const immersive = ref(sessionStorage.getItem("envman-immersive-mode") === "1");
const sidebarExpanded = ref(!window.matchMedia("(max-width: 900px)").matches);
const workspaceSwitching = ref(false);
const rememberedEnvironmentId = ref<string | null>(null);
let connectionPollTimer: number | undefined;
let connectionLimitDialogOpen = false;
let removeShortcutListener: (() => void) | undefined;
let removeHistoryNavigation: (() => void) | undefined;
let removeVisitHistory: (() => void) | undefined;

const menuItems = [
  { key: "overview", label: tr("环境总览"), icon: CircleGauge, routeName: "overview", routeNames: ["overview", "environment"], planned: false },
  { key: "connections", label: tr("连接资源池"), icon: Boxes, routeName: "connections", routeNames: ["connections", "connection-tools"], planned: false },
  { key: "ssh-keys", label: tr("SSH 密钥"), icon: KeyRound, routeName: "ssh-keys", routeNames: ["ssh-keys"], planned: false, managerOnly: true },
  { key: "ssh", label: tr("SSH 工作台"), icon: TerminalSquare, routeName: "ssh", routeNames: ["ssh"], planned: false },
  { key: "database", label: tr("数据库工作台"), icon: Database, routeName: "database", routeNames: ["database"], planned: false },
  { key: "redis", label: tr("Redis 工作台"), icon: MemoryStick, routeName: "redis", routeNames: ["redis"], planned: false },
  { key: "knowledge", label: tr("知识库"), icon: BookOpen, routeName: "knowledge", routeNames: ["knowledge"], planned: false },
  { key: "audit", label: tr("操作审计"), icon: ClipboardList, routeName: "audit", routeNames: ["audit"], planned: false },
  { key: "organization", label: tr("组织与用户"), icon: Users, routeName: "organization", routeNames: ["organization"], planned: false },
] as const;

const activeRouteName = computed(() => String(route.name ?? ""));
const activeEnvironmentId = computed(() => route.name === "environment" ? String(route.params.id ?? "") : null);
const isWorkbenchPage = computed(() => ["environment", "knowledge", "ssh", "database", "redis"].includes(activeRouteName.value));
const currentWorkspaceCommand = computed(() => session.workspace ? `${session.workspace.type}:${session.workspace.id}` : "");
const personalWorkspace = computed(() => session.workspaces.find((workspace) => workspace.type === "personal"));
const organizationWorkspaces = computed(() => session.workspaces.filter((workspace) => workspace.type === "organization"));
const visibleMenuItems = computed(() => menuItems.filter((item) => !("managerOnly" in item && item.managerOnly) || ["owner", "admin"].includes(session.workspace?.role ?? "")));

function workspaceLabel(workspace: { type: "personal" | "organization"; name: string }) {
  return workspace.type === "personal" ? tr("{0} 的个人空间", [session.user?.username ?? tr("我")]) : workspace.name;
}

watch(
  () => route.query.immersive,
  (value, previous) => {
    if (value === "1") {
      immersive.value = true;
      sessionStorage.setItem("envman-immersive-mode", "1");
    } else if (previous === "1") {
      immersive.value = false;
      sessionStorage.setItem("envman-immersive-mode", "0");
    }
  },
  { immediate: true },
);

watch(
  activeEnvironmentId,
  (environmentId) => {
    if (environmentId !== null) sidebarExpanded.value = false;
  },
  { immediate: true },
);

watch(
  [activeRouteName, activeEnvironmentId],
  ([routeName, environmentId], [previousRouteName]) => {
    rememberedEnvironmentId.value = updateRememberedEnvironmentId(
      rememberedEnvironmentId.value,
      routeName,
      environmentId,
      previousRouteName,
    );
  },
);

function isMenuActive(item: (typeof menuItems)[number]) {
  return item.routeNames.some((name) => name === activeRouteName.value);
}

async function activateMenuItem(routeName: string) {
  if (routeName === "overview") {
    const target = environmentOverviewNavigationTarget(activeRouteName.value, rememberedEnvironmentId.value);
    if (route.name !== target.name || Object.keys(route.query).length) await router.push(target);
  } else if (route.name !== routeName || Object.keys(route.query).length) await router.push({ name: routeName });
  if (window.matchMedia("(max-width: 900px)").matches) sidebarExpanded.value = false;
}

async function activateWorkspace(command: string) {
  const workspace = session.workspaces.find((item) => `${item.type}:${item.id}` === command);
  if (!workspace || command === currentWorkspaceCommand.value || workspaceSwitching.value) return;
  workspaceSwitching.value = true;
  try {
    await switchWorkspace(workspace);
    if (desktop) {
      await router.replace({ name: "overview" });
      window.location.reload();
    } else window.location.assign("/");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("切换工作空间失败"));
    workspaceSwitching.value = false;
  }
}

async function openProfile() {
  await router.push({ name: "settings", query: { section: "profile" } });
  if (window.matchMedia("(max-width: 900px)").matches) sidebarExpanded.value = false;
}

function setImmersive(value: boolean) {
  immersive.value = value;
  sessionStorage.setItem("envman-immersive-mode", value ? "1" : "0");
  if (value) ElMessage.info(tr("已进入沉浸模式，按 Esc 退出"));
  else if (route.query.immersive === "1" || route.query.webFocus === "1") {
    const query = { ...route.query };
    delete query.immersive;
    delete query.webFocus;
    void router.replace({ name: route.name ?? undefined, params: route.params, query });
  }
}

provide(immersiveModeKey, { active: readonly(immersive), setActive: setImmersive });

function toggleSidebar() {
  sidebarExpanded.value = !sidebarExpanded.value;
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (immersive.value) setImmersive(false);
    else if (sidebarExpanded.value && window.matchMedia("(max-width: 900px)").matches) sidebarExpanded.value = false;
    return;
  }
  if (!desktop && shortcutActionFromKeyboardEvent(event) === "app.settings") {
    event.preventDefault();
    void router.push({ name: "settings", query: { section: "profile" } });
  }
}

async function refreshActiveConnections() {
  await loadActiveConnections().catch(() => undefined);
}

async function openActiveConnections() {
  if (route.name !== "active-connections") await router.push({ name: "active-connections" });
  if (window.matchMedia("(max-width: 900px)").matches) sidebarExpanded.value = false;
}

function handleConnectionLimit(event: Event) {
  if (connectionLimitDialogOpen) return;
  connectionLimitDialogOpen = true;
  const message = (event as CustomEvent<{ message?: string }>).detail?.message ?? tr("当前连接数已达到上限，请先关闭现有连接再继续");
  void ElMessageBox.confirm(message, tr("连接数已达上限"), {
    type: "warning",
    confirmButtonText: tr("管理当前连接"),
    cancelButtonText: tr("取消"),
  }).then(openActiveConnections).catch(() => undefined).finally(() => { connectionLimitDialogOpen = false; });
}

watch(
  () => session.user?.id,
  (userId) => {
    window.clearInterval(connectionPollTimer);
    connectionPollTimer = undefined;
    if (!userId) return;
    void refreshActiveConnections();
    connectionPollTimer = window.setInterval(refreshActiveConnections, 3_000);
  },
  { immediate: true },
);

onMounted(() => {
  void initializeAppShortcuts();
  removeShortcutListener = onAppShortcut((action) => {
    if (action === "app.settings") void router.push({ name: "settings", query: { section: "shortcuts" } });
  });
  removeVisitHistory = installVisitHistory(router);
  removeHistoryNavigation = installHistoryNavigationGestures({
    canNavigate: visitHistoryCanNavigate,
    navigate: visitHistoryNavigate,
  });
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("viron:connection-limit", handleConnectionLimit);
});
onBeforeUnmount(() => {
  removeShortcutListener?.();
  removeHistoryNavigation?.();
  removeVisitHistory?.();
  document.removeEventListener("keydown", handleGlobalKeydown);
  window.removeEventListener("viron:connection-limit", handleConnectionLimit);
  window.clearInterval(connectionPollTimer);
});
</script>

<template>
  <div class="app-frame" :class="{ 'is-immersive': immersive, 'is-sidebar-expanded': sidebarExpanded, 'is-desktop': desktop, 'is-macos-desktop': macosDesktop }">
    <aside class="app-sidebar" :aria-label="$t('应用导航')">
      <div class="sidebar-prelayers" aria-hidden="true">
        <span class="sidebar-prelayer sidebar-prelayer--back"></span>
        <span class="sidebar-prelayer sidebar-prelayer--front"></span>
      </div>

      <div class="app-sidebar__panel">
        <button class="brand-lockup" type="button" :aria-label="$t('打开环境总览')" :title="$t('Viron 环境运维平台')" @click="activateMenuItem('overview')">
          <span class="brand-mark"><img :src="vironLogoUrl" alt="" /></span>
          <span class="brand-copy sidebar-label"><strong>Viron</strong><small>{{ $t('环境运维平台') }}</small></span>
        </button>

        <div class="workspace-switcher">
          <el-dropdown
            trigger="click"
            placement="right-start"
            popper-class="workspace-switcher-popper"
            :disabled="workspaceSwitching"
            @command="activateWorkspace"
          >
            <button
              class="workspace-switcher__trigger"
              type="button"
              :class="{ 'is-switching': workspaceSwitching }"
              :aria-label="$t('切换工作空间，当前为{0}', [session.workspace ? workspaceLabel(session.workspace) : $t('未选择')])"
              :title="sidebarExpanded ? undefined : session.workspace ? workspaceLabel(session.workspace) : $t('切换工作空间')"
            >
              <span class="workspace-switcher__icon">
                <UserRound v-if="session.workspace?.type === 'personal'" :size="16" />
                <Building2 v-else :size="16" />
              </span>
              <span class="sidebar-label-wrap">
                <span class="workspace-switcher__copy sidebar-label">
                  <small>{{ $t('当前工作空间') }}</small>
                  <strong>{{ session.workspace ? workspaceLabel(session.workspace) : $t('选择工作空间') }}</strong>
                </span>
              </span>
              <ChevronsUpDown class="workspace-switcher__chevrons sidebar-label" :size="14" />
            </button>
            <template #dropdown>
              <el-dropdown-menu class="workspace-menu">
                <li class="workspace-menu__heading" role="presentation">{{ $t('个人空间') }}</li>
                <el-dropdown-item
                  v-if="personalWorkspace"
                  :command="`personal:${personalWorkspace.id}`"
                  :class="{ 'is-current': currentWorkspaceCommand === `personal:${personalWorkspace.id}` }"
                >
                  <span class="workspace-menu__icon"><UserRound :size="16" /></span>
                  <span class="workspace-menu__copy">
                    <strong>{{ workspaceLabel(personalWorkspace) }}</strong>
                    <small>{{ $t('仅你可见') }}</small>
                  </span>
                  <Check v-if="currentWorkspaceCommand === `personal:${personalWorkspace.id}`" class="workspace-menu__check" :size="15" />
                </el-dropdown-item>
                <li v-if="organizationWorkspaces.length" class="workspace-menu__heading" role="presentation">{{ $t('已加入的组织') }}</li>
                <el-dropdown-item
                  v-for="workspace in organizationWorkspaces"
                  :key="workspace.id"
                  :command="`organization:${workspace.id}`"
                  :class="{ 'is-current': currentWorkspaceCommand === `organization:${workspace.id}` }"
                >
                  <span class="workspace-menu__icon"><Building2 :size="16" /></span>
                  <span class="workspace-menu__copy">
                    <strong>{{ workspace.name }}</strong>
                    <small>{{ workspace.role === 'admin' ? $t('组织管理员') : $t('组织成员') }}</small>
                  </span>
                  <Check v-if="currentWorkspaceCommand === `organization:${workspace.id}`" class="workspace-menu__check" :size="15" />
                </el-dropdown-item>
                <li v-if="!organizationWorkspaces.length" class="workspace-menu__empty" role="presentation">{{ $t('尚未加入组织') }}</li>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <nav id="envman-primary-menu" class="primary-menu" :aria-label="$t('主导航')">
          <button
            v-for="(item, index) in visibleMenuItems"
            :key="item.key"
            class="primary-menu__item"
            :class="{ 'is-active': isMenuActive(item) }"
            :style="{ '--item-delay': `${255 + index * 55}ms` }"
            type="button"
            :aria-current="isMenuActive(item) ? 'page' : undefined"
            :title="sidebarExpanded ? undefined : `${item.label}${item.planned ? $t(' · 待开放') : ''}`"
            @click="activateMenuItem(item.routeName)"
          >
            <span class="sidebar-menu-icon"><component :is="item.icon" :size="16" /></span>
            <span class="sidebar-label-wrap">
              <span class="sidebar-label primary-menu__label"><span>{{ item.label }}</span><small v-if="item.planned">{{ $t('待开放') }}</small></span>
            </span>
          </button>
        </nav>

        <div class="header-utilities" :aria-label="$t('平台控制')">
          <button
            class="header-icon-action sidebar-toggle"
            type="button"
            :aria-expanded="sidebarExpanded"
            aria-controls="envman-primary-menu"
            :aria-label="sidebarExpanded ? $t('收起左侧菜单') : $t('展开左侧菜单')"
            :title="sidebarExpanded ? $t('收起菜单') : $t('展开菜单')"
            @click="toggleSidebar"
          >
            <span class="header-utility-icon sidebar-toggle__icon">
              <PanelLeftClose v-if="sidebarExpanded" :size="17" />
              <PanelLeftOpen v-else :size="17" />
            </span>
            <span class="sidebar-label-wrap"><span class="sidebar-label">{{ sidebarExpanded ? $t('收起菜单') : $t('展开菜单') }}</span></span>
          </button>
          <MonitorAlertCenter :sidebar-expanded="sidebarExpanded" />
          <button
            v-if="!desktop"
            class="header-icon-action"
            :class="{ 'is-active': route.name === 'client-downloads' }"
            type="button"
            :aria-label="$t('下载 Viron 客户端')"
            :title="$t('下载客户端')"
            @click="activateMenuItem('client-downloads')"
          >
            <span class="header-utility-icon"><Download :size="17" /></span>
            <span class="sidebar-label-wrap"><span class="sidebar-label">{{ $t('下载客户端') }}</span></span>
          </button>
          <button class="header-icon-action" type="button" :aria-label="$t('进入沉浸模式')" :title="$t('沉浸模式 · Esc 退出')" @click="setImmersive(true)">
            <span class="header-utility-icon"><Maximize2 :size="17" /></span>
            <span class="sidebar-label-wrap"><span class="sidebar-label">{{ $t('沉浸模式') }}</span></span>
          </button>
          <button
            class="header-system-status"
            :class="{ 'is-active': route.name === 'active-connections' }"
            type="button"
            :aria-label="$t('当前连接： {0}/{1}', [activeConnections.current, activeConnections.limit])"
            :title="$t('当前连接： {0}/{1}', [activeConnections.current, activeConnections.limit])"
            @click="openActiveConnections"
          >
            <i></i>
            <span class="sidebar-label-wrap"><span class="sidebar-label">{{ $t('当前连接：') }} {{ activeConnections.current }}/{{ activeConnections.limit }}</span></span>
          </button>
          <div class="header-user-control" :class="{ 'is-settings-active': route.name === 'settings' }">
            <button class="header-admin-chip" type="button" :aria-label="$t('打开用户 {0} 的个人信息', [session.user?.username])" :title="sidebarExpanded ? undefined : session.user?.username" @click="openProfile">
              <span class="admin-avatar">{{ session.user?.username.slice(0, 1).toUpperCase() }}</span>
              <span class="sidebar-label-wrap"><span class="header-admin-name sidebar-label">{{ session.user?.username }}</span></span>
              <Settings class="header-user-settings-icon" :size="16" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </aside>

    <button v-if="sidebarExpanded" class="sidebar-scrim" type="button" :aria-label="$t('关闭左侧菜单')" @click="sidebarExpanded = false"></button>

    <section class="app-surface">
      <header v-if="desktop" class="desktop-window-header" :aria-label="$t('窗口标题栏')"></header>
      <main class="app-content" :class="{ 'is-workbench-page': isWorkbenchPage }">
        <slot />
      </main>
    </section>
    <AgentHostBridge v-if="desktop" />
    <AgentFloatingWindow v-if="desktop && !agentNativeOverlayActive" />
    <ActiveEnvironmentDockWindow />
    <ConnectionQualityWindow />
    <HistoryNavigationOverlay />
  </div>
</template>
