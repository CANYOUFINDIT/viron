<script setup lang="ts">
import { BellRing, CheckCheck, CircleCheck, CirclePlus, CircleX, ExternalLink, MonitorCog, X } from "@lucide/vue";
import { ElMessage, ElNotification } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import {
  isDesktopApp,
  onDesktopMonitorAlertOpen,
  showDesktopMonitorAlertNotification,
} from "../desktop";
import { translate as tr } from "../i18n";
import { monitorAlertBody, monitorAlertRuleLabel, monitorAlertTitle } from "../monitor-alert-copy";
import { session, switchWorkspace } from "../session";
import {
  MONITOR_ALERT_TOAST_DURATION_OPTIONS,
  monitorAlertToastDurationMs,
  persistMonitorAlertToastDurationSeconds,
  readMonitorAlertToastDurationSeconds,
} from "../monitor-alert-toasts";
import {
  monitorAlertNavigationQuery,
  type DesktopMonitorAlertNotification,
  type MonitorAlertItem,
  type MonitorAlertListResponse,
} from "../../shared/monitor-alerts";

defineProps<{ sidebarExpanded: boolean }>();

const router = useRouter();
const desktop = isDesktopApp();
const drawerOpen = ref(false);
const loading = ref(false);
const alerts = ref<MonitorAlertItem[]>([]);
const unread = ref(0);
const permission = ref<NotificationPermission | "unsupported">(
  desktop ? "granted" : typeof Notification === "undefined" ? "unsupported" : Notification.permission,
);
const displaying = new Set<string>();
const toastDurationSeconds = ref(readMonitorAlertToastDurationSeconds());
const openToastCount = ref(0);
let pollTimer: number | undefined;
let removeDesktopOpenListener: (() => void) | undefined;

const activeCount = computed(() => alerts.value.filter((alert) => alert.status === "active").length);
const notificationStatus = computed(() => {
  if (desktop) return tr("桌面系统通知已开启");
  if (permission.value === "granted") return tr("浏览器系统通知已开启");
  if (permission.value === "denied") return tr("浏览器已禁止系统通知");
  if (permission.value === "unsupported") return tr("当前浏览器不支持系统通知");
  return tr("浏览器系统通知尚未授权");
});

type MonitorAlertNavigationTarget = Pick<
  MonitorAlertItem,
  "id" | "workspaceType" | "workspaceId" | "environmentId" | "sshConnectionId" | "serviceId" | "deploymentId"
>;

function navigationTarget(alert: Pick<MonitorAlertItem, "environmentId" | "sshConnectionId" | "serviceId" | "deploymentId">) {
  return { name: "environment" as const, params: { id: alert.environmentId }, query: monitorAlertNavigationQuery(alert) };
}

async function markRead(alertId: string) {
  await api(`/api/v1/monitor-alerts/${alertId}/read`, { method: "POST" }).catch(() => undefined);
  const alert = alerts.value.find((item) => item.id === alertId);
  if (alert && !alert.read) {
    alert.read = true;
    unread.value = Math.max(0, unread.value - 1);
  }
}

async function openAlert(alert: MonitorAlertNavigationTarget) {
  drawerOpen.value = false;
  const currentWorkspace = session.workspace;
  const changesWorkspace = !currentWorkspace || currentWorkspace.type !== alert.workspaceType || currentWorkspace.id !== alert.workspaceId;
  const workspace = changesWorkspace
    ? session.workspaces.find((item) => item.type === alert.workspaceType && item.id === alert.workspaceId)
    : currentWorkspace;
  if (!workspace) return ElMessage.error(tr("无法打开连接位置"));
  try {
    await markRead(alert.id);
    const target = navigationTarget(alert);
    if (!changesWorkspace) {
      await router.push(target);
      return;
    }
    const href = router.resolve(target).href;
    await switchWorkspace(workspace);
    window.location.assign(href);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法打开连接位置"));
  }
}

function showBrowserSystemNotification(alert: MonitorAlertItem, phase: "active" | "recovered", title: string, body: string) {
  if (desktop || permission.value !== "granted" || typeof Notification === "undefined") return;
  const notification = new Notification(title, {
    body,
    tag: `viron-monitor:${alert.id}:${phase}`,
    requireInteraction: phase === "active",
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
    void openAlert(alert);
  };
}

async function showSystemNotification(alert: MonitorAlertItem, phase: "active" | "recovered", title: string, body: string) {
  if (desktop) {
    await showDesktopMonitorAlertNotification({
      id: alert.id,
      title,
      body,
      workspaceType: alert.workspaceType,
      workspaceId: alert.workspaceId,
      workspaceName: alert.workspaceName,
      environmentId: alert.environmentId,
      sshConnectionId: alert.sshConnectionId,
      serviceId: alert.serviceId,
      deploymentId: alert.deploymentId,
    }).catch(() => undefined);
    return;
  }
  showBrowserSystemNotification(alert, phase, title, body);
}

async function presentAlert(alert: MonitorAlertItem, phase: "active" | "recovered") {
  const key = `${alert.id}:${phase}`;
  if (displaying.has(key)) return;
  displaying.add(key);
  const title = monitorAlertTitle(alert, phase);
  const body = monitorAlertBody(alert, phase);
  openToastCount.value += 1;
  ElNotification({
    title,
    message: body,
    type: alert.status === "event" ? "warning" : phase === "active" ? "error" : "success",
    duration: monitorAlertToastDurationMs(toastDurationSeconds.value),
    offset: 52,
    position: "top-right",
    onClick: () => { void openAlert(alert); },
    onClose: () => { openToastCount.value = Math.max(0, openToastCount.value - 1); },
  });
  await showSystemNotification(alert, phase, title, body);
  await api(`/api/v1/monitor-alerts/${alert.id}/notified`, {
    method: "POST",
    body: JSON.stringify({ phase }),
  }).catch(() => undefined);
  alert.notificationPhase = null;
}

async function loadAlerts(silent = false) {
  if (!session.user) return;
  if (!silent) loading.value = true;
  try {
    const response = await api<MonitorAlertListResponse>("/api/v1/monitor-alerts");
    alerts.value = response.items;
    unread.value = response.unread;
    for (const alert of response.items) if (alert.notificationPhase) void presentAlert(alert, alert.notificationPhase);
  } finally {
    if (!silent) loading.value = false;
  }
}

async function requestSystemPermission() {
  if (desktop || typeof Notification === "undefined" || Notification.permission !== "default") return;
  permission.value = await Notification.requestPermission();
  if (permission.value === "granted") ElMessage.success(tr("浏览器系统通知已开启"));
  else ElMessage.warning(tr("浏览器系统通知未获授权，仍会显示站内告警"));
}

async function markAllRead() {
  await api("/api/v1/monitor-alerts/read-all", { method: "POST" });
  for (const alert of alerts.value) alert.read = true;
  unread.value = 0;
}

function setToastDurationSeconds(seconds: unknown) {
  toastDurationSeconds.value = persistMonitorAlertToastDurationSeconds(seconds);
}

function onToastDurationChange(event: Event) {
  const target = event.target;
  if (target instanceof HTMLSelectElement) setToastDurationSeconds(target.value);
}

function closeAllToasts() {
  ElNotification.closeAll();
}

function startPolling() {
  window.clearInterval(pollTimer);
  pollTimer = undefined;
  if (!session.user) return;
  void loadAlerts();
  pollTimer = window.setInterval(() => { void loadAlerts(true).catch(() => undefined); }, 10_000);
}

watch(() => `${session.user?.id ?? ""}:${session.workspace?.type ?? ""}:${session.workspace?.id ?? ""}`, startPolling, { immediate: true });

onMounted(() => {
  removeDesktopOpenListener = onDesktopMonitorAlertOpen((target: DesktopMonitorAlertNotification) => {
    void openAlert({
      id: target.id,
      workspaceType: target.workspaceType,
      workspaceId: target.workspaceId,
      environmentId: target.environmentId,
      sshConnectionId: target.sshConnectionId,
      serviceId: target.serviceId,
      deploymentId: target.deploymentId,
    });
  });
});

onBeforeUnmount(() => {
  ElNotification.closeAll();
  window.clearInterval(pollTimer);
  removeDesktopOpenListener?.();
});
</script>

<template>
  <button
    class="header-icon-action monitor-alert-trigger"
    :class="{ 'has-alerts': activeCount > 0, 'is-active': drawerOpen }"
    type="button"
    :aria-label="$t('监控告警，{0} 条未读', [unread])"
    :title="sidebarExpanded ? undefined : $t('监控告警')"
    @click="drawerOpen = true"
  >
    <span class="header-utility-icon"><BellRing :size="17" /></span>
    <span class="sidebar-label-wrap"><span class="sidebar-label">{{ $t('监控告警') }}</span></span>
    <strong v-if="unread" class="monitor-alert-badge">{{ unread > 99 ? '99+' : unread }}</strong>
  </button>

  <el-drawer
    v-model="drawerOpen"
    class="monitor-alert-drawer"
    :title="$t('监控告警')"
    size="min(430px, 92vw)"
    append-to-body
    :close-on-click-modal="true"
    :close-on-press-escape="true"
    @close="drawerOpen = false"
  >
    <section class="monitor-alert-center" v-loading="loading">
      <header>
        <div><strong>{{ activeCount }} {{ $t('条活动告警') }}</strong><small>{{ notificationStatus }}</small></div>
        <div>
          <label class="monitor-alert-duration">
            <span>{{ $t('自动消失') }}</span>
            <el-select :model-value="toastDurationSeconds" size="small" @update:model-value="setToastDurationSeconds">
              <el-option v-for="seconds in MONITOR_ALERT_TOAST_DURATION_OPTIONS" :key="seconds" :label="$t('{0} 秒', [seconds])" :value="seconds" />
            </el-select>
          </label>
          <el-button v-if="!desktop && permission === 'default'" size="small" plain @click="requestSystemPermission"><MonitorCog :size="14" />{{ $t('开启系统通知') }}</el-button>
          <el-button size="small" plain :disabled="!unread" @click="markAllRead"><CheckCheck :size="14" />{{ $t('全部已读') }}</el-button>
        </div>
      </header>
      <div v-if="alerts.length" class="monitor-alert-list">
        <button v-for="alert in alerts" :key="alert.id" type="button" :class="[`is-${alert.status}`, { 'is-unread': !alert.read }]" @click="openAlert(alert)">
          <span class="monitor-alert-list__icon"><CircleX v-if="alert.status === 'active'" :size="17" /><CirclePlus v-else-if="alert.status === 'event'" :size="17" /><CircleCheck v-else :size="17" /></span>
          <span class="monitor-alert-list__copy">
            <strong>{{ monitorAlertRuleLabel(alert) }} · {{ alert.targetName || alert.connectionName }}</strong>
            <small class="monitor-alert-list__location">{{ $t(alert.workspaceName) }} / {{ alert.environmentName }}</small>
            <small>{{ monitorAlertBody(alert, alert.status === 'recovered' ? 'recovered' : 'active') }}</small>
            <time>{{ new Date(alert.status === 'recovered' ? alert.recoveredAt || alert.triggeredAt : alert.triggeredAt).toLocaleString($locale()) }}</time>
          </span>
          <ExternalLink :size="14" />
        </button>
      </div>
      <div v-else class="monitor-alert-empty"><BellRing :size="25" /><strong>{{ $t('当前没有监控告警') }}</strong></div>
    </section>
  </el-drawer>

  <Teleport to="body">
    <div v-if="openToastCount > 0" class="monitor-alert-toast-toolbar" role="toolbar" :aria-label="$t('告警弹窗')">
      <label class="monitor-alert-duration">
        <span>{{ $t('自动消失') }}</span>
        <select :value="toastDurationSeconds" @change="onToastDurationChange">
          <option v-for="seconds in MONITOR_ALERT_TOAST_DURATION_OPTIONS" :key="seconds" :value="seconds">{{ $t('{0} 秒', [seconds]) }}</option>
        </select>
      </label>
      <button type="button" @click="closeAllToasts"><X :size="14" />{{ $t('全部关闭') }}</button>
    </div>
  </Teleport>
</template>

<style scoped>
.monitor-alert-trigger { position: relative; }
.monitor-alert-trigger.has-alerts { border-color: color-mix(in srgb, var(--red-600) 60%, #2a3d40); color: #ef8f84; }
.monitor-alert-badge { position: absolute; inset: -5px -5px auto auto; min-width: 18px; height: 18px; padding: 0 4px; border: 2px solid #102023; border-radius: 9px; background: #d8584d; color: white; display: grid; place-items: center; font-family: var(--font-mono); font-size: 9px; line-height: 1; }
.monitor-alert-center { min-height: 240px; }
.monitor-alert-center > header { padding: 0 0 14px; border-bottom: 1px solid var(--ink-100); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.monitor-alert-center > header > div:last-child { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.monitor-alert-duration { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-500); font-size: 12px; }
.monitor-alert-duration :deep(.el-select) { width: 92px; }
.monitor-alert-duration select {
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--ink-200);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink-800);
  font: inherit;
}
.monitor-alert-toast-toolbar {
  position: fixed;
  top: 10px;
  right: 16px;
  z-index: 4100;
  padding: 6px 7px;
  border: 1px solid var(--ink-200);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  box-shadow: 0 10px 28px rgba(8, 22, 25, .16);
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.monitor-alert-toast-toolbar button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--ink-200);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink-700);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
}
.monitor-alert-toast-toolbar button:hover { border-color: var(--teal-500); color: var(--teal-700); }
.monitor-alert-center > header strong, .monitor-alert-center > header small { display: block; }
.monitor-alert-center > header strong { font-size: 14px; }
.monitor-alert-center > header small { margin-top: 4px; color: var(--ink-400); font-size: 11px; }
.monitor-alert-list { margin-top: 10px; display: grid; }
.monitor-alert-list button { width: 100%; min-width: 0; padding: 13px 8px; border: 0; border-bottom: 1px solid var(--ink-100); background: transparent; color: var(--ink-600); display: grid; grid-template-columns: 30px minmax(0, 1fr) 18px; align-items: start; gap: 9px; text-align: left; cursor: pointer; }
.monitor-alert-list button:hover { background: var(--ink-50); }
.monitor-alert-list button.is-unread { background: color-mix(in srgb, var(--amber-100) 40%, transparent); }
.monitor-alert-list button.is-active .monitor-alert-list__icon { background: var(--red-100); color: var(--red-600); }
.monitor-alert-list button.is-event .monitor-alert-list__icon { background: var(--amber-100); color: var(--amber-700); }
.monitor-alert-list button.is-recovered .monitor-alert-list__icon { background: var(--teal-50); color: var(--teal-700); }
.monitor-alert-list__icon { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; }
.monitor-alert-list__copy { min-width: 0; }
.monitor-alert-list__copy strong, .monitor-alert-list__copy small, .monitor-alert-list__copy time { display: block; }
.monitor-alert-list__copy strong { color: var(--ink-800); font-size: 13px; }
.monitor-alert-list__copy .monitor-alert-list__location { color: var(--teal-700); font-weight: 700; }
.monitor-alert-list__copy small { margin-top: 4px; overflow-wrap: anywhere; color: var(--ink-500); font-size: 12px; line-height: 1.55; }
.monitor-alert-list__copy time { margin-top: 6px; color: var(--ink-400); font-family: var(--font-mono); font-size: 10px; }
.monitor-alert-list button > svg { margin-top: 7px; color: var(--ink-300); }
.monitor-alert-empty { min-height: 260px; color: var(--ink-400); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.monitor-alert-empty strong { font-size: 13px; }
@media (max-width: 560px) { .monitor-alert-center > header { align-items: stretch; flex-direction: column; } .monitor-alert-center > header > div:last-child { flex-wrap: wrap; } }
</style>
