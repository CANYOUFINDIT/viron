<script setup lang="ts">
import { unref } from "vue";
import { Activity, CircleAlert, Clock3, Download, EllipsisVertical, Power, RotateCw, ScanSearch } from "@lucide/vue";
import { localizeMessage } from "../../i18n";
import HostMonitorDashboard from "../HostMonitorDashboard.vue";
import HostEventCalendar from "../monitoring/HostEventCalendar.vue";
import ServiceDiscoveryPanel from "../ServiceDiscoveryPanel.vue";

const { m, environmentId } = defineProps<{
  m: Record<string, any>;
  environmentId: string;
}>();
const {
  payload,
  selectedHost,
  selectedInstallTask,
  installingHosts,
  refreshingHosts,
  clearingHosts,
  restartingHosts,
  selectedUnmanagedCount,
  selectedWorstDisk,
  discoveryManagedKeys,
  discoveryTargetServiceId,
  hostWorkspaceTab,
  hostFocusMetric,
  hostPresence,
  formatTime,
  formatRelativeCollected,
  formatPercent,
  formatBytes,
  formatDuration,
  metricTone,
  cpuVisualThreshold,
  memoryVisualThreshold,
  diskVisualThreshold,
  isInstallTaskActive,
  isMonitorInstalled,
  openInstallProgress,
  installMonitorOnHost,
  reinstallMonitorOnHost,
  restartMonitorOnHost,
  refreshHost,
  clearMonitorData,
  beginCandidateEnrollment,
  assignDiscoveryTarget,
  openServiceCreate,
  openKubernetesConfiguration,
} = m;

function peakTemperatureC(temperatures: Array<{ celsius: number }>) {
  return Math.max(...temperatures.map((item) => item.celsius)).toFixed(1);
}

function onMonitorHostCommand(command: string | number | object) {
  const host = unref(selectedHost);
  if (!host?.sshConnectionId) return;
  window.setTimeout(() => {
    if (command === "restart") void restartMonitorOnHost(host);
    else if (command === "reinstall") void reinstallMonitorOnHost(host);
    else if (command === "clear") void clearMonitorData(host);
  }, 50);
}
</script>

<template>
  <section class="host-observatory">
    <header>
      <div>
        <h3>{{ selectedHost.connectionName }}</h3>
        <p :title="`${selectedHost.username}@${selectedHost.host}:${selectedHost.port} · ${formatTime(selectedHost.lastCollectedAt)}`">{{ hostPresence(selectedHost).label }} · {{ formatRelativeCollected(selectedHost.lastCollectedAt) }}<template v-if="selectedHost.snapshot?.operatingSystem"> · {{ selectedHost.snapshot.operatingSystem }} {{ selectedHost.snapshot.architecture }}</template></p>
        <p v-if="selectedHost.lastError && selectedHost.snapshot" class="deployment-warning">{{ localizeMessage(selectedHost.lastError) }}</p>
      </div>
      <div v-if="payload.canOperate" class="host-observatory__actions">
        <el-button v-if="selectedInstallTask && (isInstallTaskActive(selectedInstallTask) || selectedInstallTask.status === 'error')" :disabled="installingHosts.has(selectedHost.sshConnectionId)" :type="selectedInstallTask.status === 'error' ? 'danger' : 'primary'" plain @click="openInstallProgress(selectedHost)"><Clock3 v-if="isInstallTaskActive(selectedInstallTask)" :size="15" /><CircleAlert v-else :size="15" />{{ isInstallTaskActive(selectedInstallTask) ? $t('查看安装进度') : $t('查看安装失败详情') }}</el-button>
        <el-button v-else-if="selectedHost.monitorUpdateAvailable || !isMonitorInstalled(selectedHost)" :loading="installingHosts.has(selectedHost.sshConnectionId)" :disabled="refreshingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId) || restartingHosts.has(selectedHost.sshConnectionId)" type="primary" @click="installMonitorOnHost(selectedHost)"><Download :size="15" />{{ isMonitorInstalled(selectedHost) ? $t('一键升级') : $t('一键安装监控服务') }}</el-button>
        <el-button :loading="refreshingHosts.has(selectedHost.sshConnectionId)" :disabled="installingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId) || restartingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)" @click="refreshHost(selectedHost)"><ScanSearch :size="15" />{{ $t('扫描并拉取') }}</el-button>
        <el-dropdown v-if="isMonitorInstalled(selectedHost) || selectedHost.installPath" trigger="click" placement="bottom-end" @command="onMonitorHostCommand">
          <button class="host-observatory__more" type="button" :aria-label="$t('更多操作')"><EllipsisVertical :size="16" /></button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="selectedHost.installPath" disabled>{{ selectedHost.installManaged ? $t('Viron 托管') : $t('手工安装') }} · {{ selectedHost.installPath }}</el-dropdown-item>
              <el-dropdown-item v-if="isMonitorInstalled(selectedHost)" command="restart" :disabled="installingHosts.has(selectedHost.sshConnectionId) || refreshingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId) || restartingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)"><RotateCw :size="14" />{{ $t('重启监控服务') }}</el-dropdown-item>
              <el-dropdown-item v-if="isMonitorInstalled(selectedHost)" command="reinstall" :disabled="installingHosts.has(selectedHost.sshConnectionId) || refreshingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId) || restartingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)"><Download :size="14" />{{ $t('重装监控服务') }}</el-dropdown-item>
              <el-dropdown-item v-if="isMonitorInstalled(selectedHost)" command="clear" divided :disabled="installingHosts.has(selectedHost.sshConnectionId) || refreshingHosts.has(selectedHost.sshConnectionId) || restartingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)">{{ $t('清理监控数据') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>
    <nav class="host-workspace-tabs" role="tablist" :aria-label="$t('宿主机工作区')">
      <button type="button" role="tab" :aria-selected="hostWorkspaceTab === 'monitor'" :class="{ 'is-active': hostWorkspaceTab === 'monitor' }" @click="hostWorkspaceTab = 'monitor'"><Activity :size="18" />{{ $t('监控') }}</button>
      <button type="button" role="tab" :aria-selected="hostWorkspaceTab === 'discovery'" :class="{ 'is-active': hostWorkspaceTab === 'discovery' }" @click="hostWorkspaceTab = 'discovery'"><ScanSearch :size="18" />{{ $t('服务发现') }}<small v-if="selectedUnmanagedCount">{{ selectedUnmanagedCount }}</small><small v-else-if="selectedHost.candidates.length" class="is-muted">{{ selectedHost.candidates.length }}</small></button>
    </nav>
    <div v-if="hostWorkspaceTab === 'monitor'" class="host-observatory__pane" role="tabpanel">
      <div v-if="selectedHost.snapshot" class="host-metric-grid" role="group" :aria-label="$t('当前快照')">
        <button type="button" :class="['is-' + metricTone(selectedHost.snapshot.cpuUsedPercent, cpuVisualThreshold), { 'is-active': hostFocusMetric === 'cpu' }]" @click="hostFocusMetric = 'cpu'"><span>CPU</span><strong>{{ formatPercent(selectedHost.snapshot.cpuUsedPercent) }}</strong><small>{{ selectedHost.snapshot.cpuCount || '—' }} {{ $t('核') }} · {{ selectedHost.snapshot.load1.toFixed(2) }}</small><i :style="{ width: Math.min(100, selectedHost.snapshot.cpuUsedPercent || 0) + '%' }"></i></button>
        <button type="button" :class="['is-' + metricTone(selectedHost.snapshot.memoryUsedPercent, memoryVisualThreshold), { 'is-active': hostFocusMetric === 'memory' }]" @click="hostFocusMetric = 'memory'"><span>{{ $t('内存') }}</span><strong>{{ formatPercent(selectedHost.snapshot.memoryUsedPercent) }}</strong><small>{{ formatBytes(selectedHost.snapshot.memoryUsedBytes) }} / {{ formatBytes(selectedHost.snapshot.memoryTotalBytes) }}</small><i :style="{ width: Math.min(100, selectedHost.snapshot.memoryUsedPercent || 0) + '%' }"></i></button>
        <button type="button" :class="['is-' + metricTone(selectedWorstDisk?.usedPercent, diskVisualThreshold), { 'is-active': hostFocusMetric === 'disk' }]" @click="hostFocusMetric = 'disk'"><span>{{ $t('磁盘') }}</span><strong>{{ formatPercent(selectedWorstDisk?.usedPercent) }}</strong><small>{{ selectedWorstDisk?.path || '—' }} · {{ selectedHost.snapshot.disks.length }} {{ $t('挂载点') }}</small><i :style="{ width: Math.min(100, selectedWorstDisk?.usedPercent || 0) + '%' }"></i></button>
        <button v-if="selectedHost.snapshot.temperatures.length" type="button" :class="{ 'is-active': hostFocusMetric === 'temperature' }" @click="hostFocusMetric = 'temperature'"><span>{{ $t('温度') }}</span><strong>{{ peakTemperatureC(selectedHost.snapshot.temperatures) }}°C</strong><small>{{ selectedHost.snapshot.temperatures[0]?.chip }}</small></button>
        <div class="host-metric-uptime"><span>{{ $t('运行时间') }}</span><strong>{{ formatDuration(selectedHost.snapshot.uptimeSeconds) }}</strong></div>
      </div>
      <HostEventCalendar
        v-if="selectedHost.snapshot || isMonitorInstalled(selectedHost)"
        :environment-id="environmentId"
        :host-id="selectedHost.sshConnectionId"
      />
      <HostMonitorDashboard
        v-if="selectedHost.snapshot || isMonitorInstalled(selectedHost)"
        v-model:focus-metric="hostFocusMetric"
        :environment-id="environmentId"
        :host-id="selectedHost.sshConnectionId"
        :last-collected-at="selectedHost.lastCollectedAt"
        :cpu-threshold="cpuVisualThreshold"
        :memory-threshold="memoryVisualThreshold"
        :disk-threshold="diskVisualThreshold"
      />
      <div v-else class="host-observatory__empty" :class="`is-${selectedHost.monitorStatus}`">
        <Power :size="24" /><div><strong>{{ selectedHost.monitorStatus === 'missing' ? $t('尚未安装 viron-monitor') : $t('尚未取得监控数据') }}</strong><p>{{ selectedHost.lastError || $t('点击“一键安装监控服务”，Viron 会预检权限和目录后通过现有 SSH 链路自动安装。') }}</p></div>
      </div>
    </div>
    <div v-else class="host-observatory__pane is-discovery" role="tabpanel">
      <ServiceDiscoveryPanel
        :host-id="selectedHost.sshConnectionId"
        :candidates="selectedHost.candidates"
        :kubernetes-configs="selectedHost.kubernetesConfigs"
        :services="payload.services"
        :managed-keys="discoveryManagedKeys"
        :can-configure="payload.canConfigure"
        :can-operate="payload.canOperate"
        :target-service-id="discoveryTargetServiceId"
        @enroll="beginCandidateEnrollment"
        @update:target-service-id="assignDiscoveryTarget"
        @create-service="openServiceCreate(true)"
        @configure-kubernetes="openKubernetesConfiguration"
      />
    </div>
  </section>
</template>

<style scoped>
.host-workspace-tabs {
  min-width: 0;
  margin-block-start: .125rem;
  padding: 3px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  background: var(--ink-50);
}
.host-workspace-tabs button {
  min-width: 0;
  min-height: 2.125rem;
  padding: 0 .75rem;
  border: 0;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .375rem;
  background: transparent;
  color: var(--ink-500);
  font: inherit;
  font-size: .875rem;
  font-weight: 750;
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), box-shadow var(--dur-micro) var(--ease-out);
}
.host-workspace-tabs button.is-active {
  background: var(--surface);
  color: var(--teal-700);
  box-shadow: 0 1px 5px rgba(8, 22, 25, .1);
}
.host-workspace-tabs small {
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 .35rem;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: .75rem;
  font-variant-numeric: tabular-nums;
}
.host-workspace-tabs button.is-active small { background: var(--teal-50); color: var(--teal-700); }
.host-workspace-tabs small.is-muted { background: transparent; color: var(--ink-400); }
.host-workspace-tabs button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.host-observatory__pane { min-width: 0; min-height: 0; padding-block-start: var(--space-md); overflow: auto; }
.host-observatory__pane.is-discovery { overflow: visible; }
.host-metric-grid {
  margin-block-start: var(--space-sm);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  overflow: hidden;
  background: var(--color-paper);
}
.host-metric-grid > button,
.host-metric-uptime {
  position: relative;
  min-width: 0;
  min-height: 4.75rem;
  padding: var(--space-sm);
  border: 0;
  border-inline-end: 1px solid var(--color-rule);
  display: grid;
  align-content: center;
  gap: 2px;
  background: transparent;
  color: inherit;
  text-align: start;
}
.host-metric-grid > button { cursor: pointer; }
.host-metric-grid > button:last-child,
.host-metric-uptime:last-child { border-inline-end: 0; }
.host-metric-grid span { color: var(--color-muted); font-size: var(--text-2xs); }
.host-metric-grid strong { font-family: var(--font-mono); font-size: var(--text-lg); font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.host-metric-grid small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-2xs); }
.host-metric-grid > button > i {
  position: absolute;
  inset: auto 0 0 0;
  height: 3px;
  background: var(--color-accent);
}
.host-metric-grid > button.is-warn > i { background: var(--color-warning); }
.host-metric-grid > button.is-critical > i { background: var(--color-danger); }
.host-metric-grid > button.is-warn strong { color: var(--color-warning); }
.host-metric-grid > button.is-critical strong { color: var(--color-danger); }
.host-metric-grid > button.is-active { background: var(--color-accent-soft); }
.host-metric-uptime { background: var(--color-paper-muted); }
.host-observatory__empty {
  margin-block-start: var(--space-md);
  padding: var(--space-md);
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  background: var(--color-paper-muted);
  color: var(--color-muted);
}
.host-observatory__empty > div { min-width: 0; }
.host-observatory__empty strong { color: var(--color-ink-soft); font-size: var(--text-sm); }
.host-observatory__empty p { font-size: var(--text-xs); }

@media (hover: hover) and (pointer: fine) {
  .host-workspace-tabs button:hover:not(.is-active) { color: var(--ink-800); }
  .host-metric-grid > button:hover:not(.is-active) { background: var(--ink-50); }
}

@media (pointer: coarse) {
  .host-workspace-tabs button { min-width: 2.75rem; min-height: 2.75rem; }
}

@media (prefers-reduced-motion: reduce) {
  .host-workspace-tabs button { transition-duration: var(--dur-micro); transform: none !important; }
}
</style>
