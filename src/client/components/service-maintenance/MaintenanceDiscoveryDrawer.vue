<script setup lang="ts">
import { CircleAlert, Clock3, Download, EllipsisVertical, RefreshCw, ScanSearch, Server } from "@lucide/vue";
import { localizeMessage } from "../../i18n";
import ServiceDiscoveryPanel from "../ServiceDiscoveryPanel.vue";

const { m } = defineProps<{ m: Record<string, any> }>();
const {
  payload,
  selectedHost,
  selectedInstallTask,
  installingHosts,
  refreshingHosts,
  clearingHosts,
  selectedUnmanagedCount,
  discoveryManagedKeys,
  discoveryTargetServiceId,
  hostPresence,
  formatTime,
  formatRelativeCollected,
  isInstallTaskActive,
  isMonitorInstalled,
  openInstallProgress,
  installMonitorOnHost,
  refreshHost,
  clearMonitorData,
  beginCandidateEnrollment,
  assignDiscoveryTarget,
  openServiceCreate,
  openKubernetesConfiguration,
} = m;
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
        <el-button v-else-if="selectedHost.monitorUpdateAvailable || !isMonitorInstalled(selectedHost)" :loading="installingHosts.has(selectedHost.sshConnectionId)" :disabled="refreshingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId)" type="primary" @click="installMonitorOnHost(selectedHost)"><Download :size="15" />{{ isMonitorInstalled(selectedHost) ? $t('更新监控服务') : $t('一键安装监控服务') }}</el-button>
        <el-button :loading="refreshingHosts.has(selectedHost.sshConnectionId)" :disabled="installingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)" @click="refreshHost(selectedHost)"><RefreshCw :size="15" />{{ $t('刷新') }}</el-button>
        <el-dropdown v-if="isMonitorInstalled(selectedHost) || selectedHost.installPath" trigger="click" placement="bottom-end">
          <button class="host-observatory__more" type="button" :aria-label="$t('更多操作')"><EllipsisVertical :size="16" /></button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="selectedHost.installPath" disabled>{{ selectedHost.installManaged ? $t('Viron 托管') : $t('手工安装') }} · {{ selectedHost.installPath }}</el-dropdown-item>
              <el-dropdown-item v-if="isMonitorInstalled(selectedHost)" :disabled="installingHosts.has(selectedHost.sshConnectionId) || refreshingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)" @click="clearMonitorData(selectedHost)">{{ $t('清理监控数据') }}</el-dropdown-item>
              <el-dropdown-item @click="refreshHost(selectedHost)">{{ $t('扫描并拉取') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>
    <nav class="host-workspace-tabs" role="tablist" :aria-label="$t('宿主机工作区')">
      <button type="button" role="tab" :aria-selected="true" class="is-active"><ScanSearch :size="18" />{{ $t('服务发现') }}<small v-if="selectedUnmanagedCount">{{ selectedUnmanagedCount }}</small><small v-else-if="selectedHost.candidates.length" class="is-muted">{{ selectedHost.candidates.length }}</small></button>
    </nav>
    <div class="host-observatory__pane is-discovery" role="tabpanel">
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
