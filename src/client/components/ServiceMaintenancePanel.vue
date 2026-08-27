<script setup lang="ts">
import { localizeMessage, translate as tr } from "../i18n";
import { providerLabel } from "../service-candidate-tree";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BellRing,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Download,
  EllipsisVertical,
  FileText,
  GripVertical,
  Hammer,
  Package,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  RotateCw,
  ScanSearch,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from "@lucide/vue";
import { ElMessage } from "element-plus";
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from "vue";
import AnimatedCounter from "./AnimatedCounter.vue";
import MaintenanceBatchProgress from "./service-maintenance/MaintenanceBatchProgress.vue";
import MaintenanceDeploymentGrid from "./service-maintenance/MaintenanceDeploymentGrid.vue";
import MaintenanceDiscoveryDrawer from "./service-maintenance/MaintenanceDiscoveryDrawer.vue";
import MaintenanceOperationsRibbon from "./service-maintenance/MaintenanceOperationsRibbon.vue";
import MaintenanceServiceSelector from "./service-maintenance/MaintenanceServiceSelector.vue";
import { createMaintenanceContext } from "./service-maintenance/context";
import { useMaintenancePayload } from "./service-maintenance/use-maintenance-payload";
import { useMaintenanceDirectory } from "./service-maintenance/use-maintenance-directory";
import { useMonitorInstall } from "./service-maintenance/use-monitor-install";
import { useScriptActions } from "./service-maintenance/use-script-actions";
import { useAlertSettings } from "./service-maintenance/use-alert-settings";
import type { MaintenanceCounts } from "./service-maintenance/types";

const props = defineProps<{
  environmentId: string;
  focusHostId?: string;
  focusServiceId?: string;
  focusDeploymentId?: string;
  focusEndpointId?: string;
}>();
const emit = defineEmits<{ "count-change": [counts: MaintenanceCounts]; "open-log": [logId: string]; "open-ssh": [connectionId: string] }>();
const maintenanceContext = createMaintenanceContext();
const maintenancePayload = useMaintenancePayload(maintenanceContext, props, emit);
maintenanceContext.payload = maintenancePayload;
const maintenanceDirectory = useMaintenanceDirectory(maintenanceContext, props, emit);
maintenanceContext.directory = maintenanceDirectory;
const monitorInstall = useMonitorInstall(maintenanceContext, props, emit);
maintenanceContext.monitorInstall = monitorInstall;
const scriptActions = useScriptActions(maintenanceContext, props, emit);
maintenanceContext.scriptActions = scriptActions;
const alertSettings = useAlertSettings(maintenanceContext, props, emit);
maintenanceContext.alertSettings = alertSettings;
const maintenance = { ...maintenancePayload, ...maintenanceDirectory, ...monitorInstall, ...scriptActions, ...alertSettings };

const {
  loading,
  saving,
  payload,
  selectedServiceId,
  selectedHostId,
  activeWorkspace,
  hostWorkspaceTab,
  hostFocusMetric,
  discoveryTargetServiceId,
  pendingDiscoveryCandidate,
  creatingServiceFromDiscovery,
  servicePickerDialog,
  refreshingHosts,
  runningAction,
  serviceDialog,
  deploymentDialog,
  logDialog,
  kubernetesDialog,
  editingServiceId,
  editingDeploymentId,
  manualDeployment,
  savingKubernetes,
  refreshTimer,
  serviceForm,
  deploymentForm,
  selectedLogIds,
  selectedKubernetesContextKeys,
  selectedService,
  selectedHost,
  selectedLogs,
  hostCandidates,
  candidateOptions,
  serviceSummary,
  runningDeployments,
  problemDeployments,
  monitoredHosts,
  offlineHosts,
  unmonitoredHosts,
  attentionItems,
  selectedUnmanagedCount,
  selectedWorstDisk,
  selectableKubernetesConfigs,
  discoveryManagedKeys,
  load,
  reload,
  countPhysicalMonitorHosts,
  fetchMaintenance,
  applyFocusTarget,
  stopAutoRefresh,
  startAutoRefresh,
  summarizeService,
  statusLabel,
  candidateLocationLabel,
  supportsMaintenanceActions,
  deploymentAllowsAction,
  unsupportedMaintenanceActionReason,
  deploymentIdentity,
  kubernetesMetric,
  kubernetesContextKey,
  kubernetesConfigStatusLabel,
  openKubernetesConfiguration,
  saveKubernetesConfiguration,
  formatPercent,
  formatBytes,
  formatDuration,
  formatTime,
  formatRelativeCollected,
  hostPresence,
  hostLiveCpu,
  worstDisk,
  metricTone,
  hostUnmanagedCount,
  visualThreshold,
  selectService,
  selectHost,
  openWorkspaceTab,
  openServiceCreate,
  openServiceEdit,
  saveService,
  removeService,
  resetDeploymentForm,
  openDeploymentCreate,
  assignDiscoveryTarget,
  beginCandidateEnrollment,
  pickServiceForDiscovery,
  createServiceFromDiscovery,
  cancelServicePicker,
  onServicePickerClosed,
  discoveryPickerIntro,
  openDeploymentEdit,
  saveDeployment,
  removeDeployment,
  openLogLinks,
  saveLogLinks,
  refreshHost,
  runMaintenanceAction,
  selectedDeploymentIds,
  batchDialog,
  batchOperation,
  toggleDeploymentSelection,
  selectAllVisibleDeployments,
  clearDeploymentSelection,
  runBatchMaintenanceAction,
  retryFailedBatchTargets,
  draggingDirectory,
  serviceDropTarget,
  hostDropTarget,
  savingServiceOrder,
  savingHostOrder,
  canSortDirectory,
  directoryIds,
  orderedDirectoryItems,
  directoryDropTarget,
  insertAfterDirectoryTarget,
  startDirectoryDrag,
  dragDirectoryOver,
  leaveDirectoryDropTarget,
  persistDirectoryOrder,
  dropDirectoryItem,
  endDirectoryDrag,
  canMoveDirectoryItem,
  moveDirectoryItem,
  handleDirectoryMove,
  installingHosts,
  clearingHosts,
  installTask,
  installTaskConnectionId,
  installProgressDialog,
  installTaskTimer,
  notifiedInstallTasks,
  selectedInstallTask,
  installTaskSteps,
  isInstallTaskActive,
  stopInstallTaskPolling,
  startInstallTaskPolling,
  switchInstallTaskHost,
  refreshInstallTask,
  openInstallProgress,
  installTaskStepState,
  installTaskStatusLabel,
  formatInstallTaskElapsed,
  formatInstallLogTime,
  isMonitorInstalled,
  validMonitorInstallPath,
  promptMonitorInstallPath,
  installMonitorOnHost,
  clearMonitorData,
  scriptActionIconComponents,
  scriptActionIconOptions,
  runningScriptActionId,
  scriptActionManagerDialog,
  scriptActionEditorOpen,
  scriptActionResultDialog,
  editingScriptActionId,
  scriptActionExecution,
  scriptActionScope,
  scriptActionForm,
  scopedScriptActions,
  resolveScriptActionIcon,
  resetScriptActionForm,
  beginScriptActionCreate,
  beginScriptActionEdit,
  openScriptActionManager,
  saveScriptAction,
  removeScriptAction,
  executeScriptAction,
  formatScriptDuration,
  scriptExecutionSummary,
  alertSettingsDialog,
  savingAlertSettings,
  alertSettingsForm,
  cpuVisualThreshold,
  memoryVisualThreshold,
  diskVisualThreshold,
  monitorDiskOptions,
  openAlertSettings,
  saveAlertSettings,
} = maintenance;

watch(selectedService, (service) => {
  if (service && selectedServiceId.value !== service.id) selectedServiceId.value = service.id;
}, { immediate: true });

watch(selectedHost, (host) => {
  if (host && selectedHostId.value !== host.sshConnectionId) selectedHostId.value = host.sshConnectionId;
  if (host && installTaskConnectionId.value !== host.sshConnectionId) switchInstallTaskHost(host.sshConnectionId);
}, { immediate: true });

watch(serviceDialog, (open) => {
  if (open || !creatingServiceFromDiscovery.value) return;
  creatingServiceFromDiscovery.value = false;
  pendingDiscoveryCandidate.value = null;
});

watch(() => deploymentForm.candidateKey, (key) => {
  if (!key || manualDeployment.value) return;
  const candidate = candidateOptions.value.find((item) => item.key === key);
  if (!candidate) return;
  Object.assign(deploymentForm, {
    provider: candidate.provider,
    externalId: candidate.externalId,
    displayName: candidate.name,
    origin: "discovered",
  });
});

onMounted(() => {
  void load().catch((error) => ElMessage.error(error instanceof Error ? error.message : tr("读取服务维护数据失败")));
  startAutoRefresh();
});
onActivated(() => {
  void load(true).catch(() => undefined);
  startAutoRefresh();
  if (installTaskConnectionId.value) void refreshInstallTask(installTaskConnectionId.value, false);
});
onDeactivated(() => {
  stopAutoRefresh();
  stopInstallTaskPolling();
});
onBeforeUnmount(() => {
  stopAutoRefresh();
  stopInstallTaskPolling();
});
</script>

<template>
  <section class="maintenance-console" v-loading="loading">
    <div class="maintenance-chrome">
      <nav class="maintenance-switcher" :aria-label="$t('服务维护清单')">
        <div class="maintenance-switcher__primary" role="tablist" :aria-label="$t('服务与主机')">
          <button type="button" role="tab" :aria-selected="activeWorkspace === 'service'" :class="{ 'is-active': activeWorkspace === 'service' }" @click="openWorkspaceTab('service')">{{ $t('服务') }}<small>{{ payload.services.length }}</small></button>
          <button type="button" role="tab" :aria-selected="activeWorkspace === 'host'" :class="{ 'is-active': activeWorkspace === 'host' }" @click="openWorkspaceTab('host')">{{ $t('扫描发现') }}<small>{{ payload.hosts.reduce((sum, host) => sum + (host.candidateCount ?? host.candidates.length), 0) }}</small></button>
        </div>
      </nav>
      <header class="maintenance-toolbar">
        <div class="maintenance-summary" :aria-label="$t('服务维护')">
          <span v-for="item in attentionItems" :key="item.key"><i :class="item.key === 'problems' || item.key === 'offline' ? 'is-amber' : 'is-muted'"></i><strong>{{ item.value }}</strong><small>{{ item.label }}</small></span>
          <span v-if="!attentionItems.length" class="is-quiet"><i class="is-green"></i><strong>{{ runningDeployments }}</strong><small>{{ $t('运行节点') }}</small></span>
        </div>
        <div v-if="payload.canConfigure" class="maintenance-toolbar__actions">
          <el-button :type="payload.alertSettings.enabled ? 'warning' : 'default'" plain @click="openAlertSettings"><BellRing :size="16" />{{ $t('告警设置') }}</el-button>
          <el-button v-if="activeWorkspace === 'service'" type="primary" @click="openServiceCreate()"><Plus :size="16" />{{ $t('录入服务') }}</el-button>
        </div>
      </header>
    </div>

    <div class="maintenance-layout">
      <MaintenanceServiceSelector :m="maintenance" />

      <main class="maintenance-workspace">
        <template v-if="activeWorkspace === 'service' && selectedService">
          <header class="service-stage__header">
            <div>
              <div class="service-title-line"><h3>{{ selectedService.name }}</h3><span class="status-seal" :class="`is-${serviceSummary.status}`"><Activity :size="15" />{{ serviceSummary.label }}</span></div>
              <p v-if="selectedService.description">{{ selectedService.description }}</p>
            </div>
            <div v-if="payload.canConfigure" class="service-stage__actions">
              <button v-if="payload.scriptActionsSupported" type="button" :title="$t('管理服务功能按钮')" :aria-label="$t('管理服务功能按钮')" @click="openScriptActionManager()"><Settings2 :size="16" /></button>
              <button type="button" :title="$t('关联日志')" :aria-label="$t('关联日志')" @click="openLogLinks"><FileText :size="16" /></button>
              <button type="button" :title="$t('编辑服务')" :aria-label="$t('编辑服务')" @click="openServiceEdit"><Pencil :size="16" /></button>
              <button type="button" class="is-danger" :title="$t('删除服务')" :aria-label="$t('删除服务')" @click="removeService"><Trash2 :size="16" /></button>
              <el-button type="primary" plain @click="openDeploymentCreate()"><Plus :size="15" />{{ $t('添加部署节点') }}</el-button>
            </div>
          </header>

          <MaintenanceOperationsRibbon :m="maintenance" @open-log="(id) => emit('open-log', id)" />
          <MaintenanceDeploymentGrid :m="maintenance" @open-log="(id) => emit('open-log', id)" @open-ssh="(id) => emit('open-ssh', id)" />
        </template>

        <MaintenanceDiscoveryDrawer v-else-if="activeWorkspace === 'host' && selectedHost" :m="maintenance" />
        <div v-else-if="activeWorkspace === 'host'" class="workspace-empty"><Server :size="26" /><strong>{{ $t('尚未关联 SSH 主机') }}</strong></div>
        <div v-else class="workspace-empty"><Wrench :size="26" /><strong>{{ $t('尚未录入服务') }}</strong><el-button v-if="payload.canConfigure" type="primary" @click="openServiceCreate()"><Plus :size="16" />{{ $t('录入服务') }}</el-button></div>
      </main>
    </div>

    <el-dialog v-model="scriptActionManagerDialog" align-center class="envman-dialog script-action-manager-dialog" :title="$t('{{0}} · 功能按钮', [scriptActionScope.label])" width="760px">
      <section class="script-action-manager">
        <header>
          <div><strong>{{ scriptActionScope.deploymentId ? $t('节点功能按钮') : $t('服务功能按钮') }}</strong><p>{{ scriptActionScope.deploymentId ? $t('点击后只在当前部署节点的 SSH 连接上执行。') : $t('点击后在当前服务的全部部署节点上执行。') }}</p></div>
          <el-button v-if="!scriptActionEditorOpen" type="primary" plain @click="beginScriptActionCreate"><Plus :size="15" />{{ $t('新建功能按钮') }}</el-button>
        </header>
        <div v-if="scopedScriptActions.length" class="script-action-manager__list">
          <article v-for="action in scopedScriptActions" :key="action.id" :class="{ 'is-editing': editingScriptActionId === action.id }">
            <span><component :is="resolveScriptActionIcon(action.icon)" :size="17" /></span>
            <div><strong>{{ action.name }}</strong><small>/bin/sh · {{ action.scriptBody?.length ?? 0 }} {{ $t('字符') }}</small></div>
            <button type="button" :title="$t('编辑')" @click="beginScriptActionEdit(action)"><Pencil :size="14" /></button>
            <button type="button" class="is-danger" :title="$t('删除')" @click="removeScriptAction(action)"><Trash2 :size="14" /></button>
          </article>
        </div>
        <div v-else-if="!scriptActionEditorOpen" class="script-action-manager__empty"><Terminal :size="23" /><strong>{{ $t('还没有功能按钮') }}</strong><p>{{ $t('创建后，按钮会直接显示在对应的服务或部署节点上。') }}</p></div>
        <section v-if="scriptActionEditorOpen" class="script-action-editor">
          <header><strong>{{ editingScriptActionId ? $t('编辑功能按钮') : $t('新建功能按钮') }}</strong><button type="button" :title="$t('关闭')" @click="scriptActionEditorOpen = false; resetScriptActionForm()">×</button></header>
          <el-form label-position="top">
            <el-form-item :label="$t('按钮名称')" required><el-input v-model="scriptActionForm.name" :maxlength="80" show-word-limit :placeholder="$t('例如：发布、清缓存、同步配置')" /></el-form-item>
            <el-form-item :label="$t('按钮图标')" required>
              <div class="script-icon-picker">
                <button v-for="icon in scriptActionIconOptions" :key="icon" type="button" :class="{ 'is-active': scriptActionForm.icon === icon }" :aria-label="icon" @click="scriptActionForm.icon = icon"><component :is="resolveScriptActionIcon(icon)" :size="18" /></button>
              </div>
            </el-form-item>
            <el-form-item :label="$t('脚本正文')" required>
              <el-input v-model="scriptActionForm.scriptBody" class="script-body-input" type="textarea" :rows="12" :maxlength="65536" :placeholder="$t('#!/bin/sh\nset -eu\n\n# 在此输入要通过 SSH 执行的脚本')" />
              <small class="script-action-editor__hint">{{ $t('脚本通过 /bin/sh 执行，使用部署节点对应 SSH 连接的登录用户和默认工作目录。') }}</small>
            </el-form-item>
          </el-form>
          <footer><el-button @click="scriptActionEditorOpen = false; resetScriptActionForm()">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveScriptAction">{{ $t('保存功能按钮') }}</el-button></footer>
        </section>
      </section>
      <template #footer><el-button @click="scriptActionManagerDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="scriptActionResultDialog" align-center class="envman-dialog script-action-result-dialog" :title="$t('功能脚本执行结果')" width="780px">
      <section v-if="scriptActionExecution" class="script-action-results">
        <header :class="scriptActionExecution.ok ? 'is-success' : 'is-warning'">
          <span><Check v-if="scriptActionExecution.ok" :size="18" /><CircleAlert v-else :size="18" /></span>
          <div><strong>{{ scriptActionExecution.action.name }}</strong><p>{{ scriptExecutionSummary(scriptActionExecution) }}</p></div>
        </header>
        <article v-for="result in scriptActionExecution.results" :key="result.deploymentId" :class="result.ok ? 'is-success' : 'is-error'">
          <header><span><Check v-if="result.ok" :size="15" /><CircleAlert v-else :size="15" /></span><div><strong>{{ result.targetName }}</strong><small>{{ result.connectionName }} · {{ formatScriptDuration(result.durationMs) }} · exit {{ result.exitCode ?? '—' }}</small></div></header>
          <p v-if="result.message" class="script-action-result__message">{{ localizeMessage(result.message) }}</p>
          <details v-if="result.stdout || result.stderr">
            <summary>{{ $t('查看输出') }}<small v-if="result.truncated">{{ $t('输出已截断') }}</small></summary>
            <div v-if="result.stdout"><strong>stdout</strong><pre>{{ result.stdout }}</pre></div>
            <div v-if="result.stderr"><strong>stderr</strong><pre>{{ result.stderr }}</pre></div>
          </details>
        </article>
      </section>
      <template #footer><el-button type="primary" @click="scriptActionResultDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="installProgressDialog" align-center class="envman-dialog monitor-install-progress-dialog" :close-on-click-modal="false" :title="$t('监控服务安装进度')" width="720px">
      <section v-if="selectedInstallTask" class="monitor-install-progress">
        <header class="monitor-install-progress__summary" :class="`is-${selectedInstallTask.status}`">
          <span class="monitor-install-progress__status"><Check v-if="selectedInstallTask.status === 'success'" :size="19" /><CircleAlert v-else-if="selectedInstallTask.status === 'error'" :size="19" /><RefreshCw v-else :size="18" class="is-spinning" /></span>
          <div><strong>{{ installTaskStatusLabel(selectedInstallTask) }}</strong><p>{{ localizeMessage(selectedInstallTask.currentMessage) }}</p></div>
          <time>{{ formatInstallTaskElapsed(selectedInstallTask) }}</time>
        </header>

        <dl class="monitor-install-progress__target">
          <div><dt>{{ $t('目标主机') }}</dt><dd>{{ selectedInstallTask.connectionName }}</dd></div>
          <div><dt>{{ $t('安装目录') }}</dt><dd><code>{{ selectedInstallTask.installPath }}</code></dd></div>
        </dl>

        <div class="monitor-install-progress__bar">
          <el-progress :percentage="selectedInstallTask.progress" :status="selectedInstallTask.status === 'error' ? 'exception' : selectedInstallTask.status === 'success' ? 'success' : undefined" :stroke-width="7" />
        </div>

        <ol class="monitor-install-steps">
          <li v-for="(step, index) in installTaskSteps" :key="step.phase" :class="`is-${installTaskStepState(index)}`">
            <span><Check v-if="installTaskStepState(index) === 'complete'" :size="14" /><CircleAlert v-else-if="installTaskStepState(index) === 'error'" :size="14" /><i v-else>{{ index + 1 }}</i></span>
            <div><strong>{{ step.label }}</strong><small>{{ step.description }}</small></div>
          </li>
        </ol>

        <details class="monitor-install-logs">
          <summary>{{ $t('详细日志') }}<small>{{ selectedInstallTask.logs.length }} {{ $t('条日志') }}</small><ChevronRight :size="15" /></summary>
          <div class="monitor-install-logs__body">
            <p v-for="(entry, index) in selectedInstallTask.logs" :key="`${entry.at}:${index}`" :class="`is-${entry.kind}`"><time>{{ formatInstallLogTime(entry.at) }}</time><code>{{ localizeMessage(entry.message) }}</code></p>
          </div>
        </details>
      </section>
      <div v-else class="monitor-install-progress__loading"><RefreshCw :size="20" class="is-spinning" />{{ $t('正在读取安装任务') }}</div>
      <template #footer>
        <el-button @click="installProgressDialog = false">{{ selectedInstallTask && isInstallTaskActive(selectedInstallTask) ? $t('关闭并在后台继续') : $t('关闭') }}</el-button>
        <el-button v-if="selectedInstallTask?.status === 'error' && selectedHost" type="primary" :loading="installingHosts.has(selectedHost.sshConnectionId)" @click="installMonitorOnHost(selectedHost)"><RefreshCw :size="15" />{{ $t('重新安装') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="servicePickerDialog" align-center class="envman-dialog discovery-service-picker-dialog" :title="$t('选择要纳管到的服务')" width="520px" @closed="onServicePickerClosed">
      <p class="log-dialog-intro">{{ discoveryPickerIntro() }}</p>
      <div class="discovery-service-picker">
        <button v-for="service in payload.services" :key="service.id" type="button" @click="pickServiceForDiscovery(service.id)">
          <span class="service-mark" :class="`is-${summarizeService(service).status}`"><Box :size="16" /></span>
          <span><strong>{{ service.name }}</strong><small>{{ summarizeService(service).label }} · {{ service.deployments.length }} {{ $t('节点') }}</small></span>
        </button>
      </div>
      <template #footer>
        <el-button @click="cancelServicePicker">{{ $t('取消') }}</el-button>
        <el-button type="primary" plain @click="createServiceFromDiscovery"><Plus :size="15" />{{ $t('录入新服务') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="serviceDialog" align-center class="envman-dialog" :title="editingServiceId ? $t('编辑服务') : $t('录入服务')" width="560px">
      <el-form label-position="top">
        <el-form-item :label="$t('服务名称')" required><el-input v-model="serviceForm.name" :placeholder="$t('例如：订单 API')" /></el-form-item>
        <el-form-item :label="$t('服务说明')"><el-input v-model="serviceForm.description" type="textarea" :rows="3" :placeholder="$t('说明服务职责、依赖或维护注意事项')" /></el-form-item>
        <el-form-item :label="$t('管理状态')"><el-radio-group v-model="serviceForm.status"><el-radio-button value="active">{{ $t('启用') }}</el-radio-button><el-radio-button value="disabled">{{ $t('停用') }}</el-radio-button></el-radio-group></el-form-item>
      </el-form>
      <template #footer><el-button @click="serviceDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveService">{{ $t('保存服务') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="deploymentDialog" align-center class="envman-dialog" :title="editingDeploymentId ? $t('编辑部署节点') : $t('纳管部署节点')" width="640px">
      <el-form label-position="top">
        <el-form-item :label="$t('SSH 连接')" required><el-select v-model="deploymentForm.sshConnectionId" style="width:100%" @change="Object.assign(deploymentForm, { candidateKey: '', externalId: '', displayName: '', origin: 'manual' })"><el-option v-for="host in payload.hosts" :key="host.sshConnectionId" :value="host.sshConnectionId" :label="`${host.connectionName} · ${host.username}@${host.host}`" /></el-select></el-form-item>
        <el-form-item><el-switch v-model="manualDeployment" :active-text="$t('手动录入')" /></el-form-item>
        <template v-if="!manualDeployment">
          <el-form-item :label="$t('扫描到的服务')" required><el-select v-model="deploymentForm.candidateKey" filterable style="width:100%" :placeholder="candidateOptions.length ? $t('选择要纳管的服务') : $t('请先扫描该 SSH 主机')"><el-option v-for="candidate in candidateOptions" :key="candidate.key" :value="candidate.key" :label="candidate.label" /></el-select></el-form-item>
        </template>
        <template v-else>
          <div class="deployment-form-grid">
            <el-form-item :label="$t('服务类型')" required><el-select v-model="deploymentForm.provider" style="width:100%"><el-option label="systemd" value="systemd" /><el-option label="Docker" value="docker" /><el-option label="Podman" value="podman" /><el-option label="Supervisor" value="supervisor" /><el-option :label="$t('普通进程（仅登记）')" value="process" /></el-select></el-form-item>
            <el-form-item :label="$t('服务标识')" required><el-input v-model="deploymentForm.externalId" :placeholder="$t('unit、容器 ID、Supervisor 名称或进程匹配式')" /></el-form-item>
          </div>
        </template>
        <el-form-item :label="$t('显示名称')"><el-input v-model="deploymentForm.displayName" :placeholder="$t('留空时使用扫描名称或服务标识')" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="deploymentDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveDeployment">{{ $t('保存部署节点') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="kubernetesDialog" align-center class="envman-dialog kubernetes-dialog" :title="$t('选择 Kubernetes 扫描范围')" width="680px">
      <p class="kubernetes-dialog__intro">{{ $t('Viron 只保存 kubeconfig 路径、集群和 context 等非敏感元数据；证书、Token 和私钥始终留在目标 SSH 主机。只有选中的 context 才会连接 Kubernetes API。') }}</p>
      <el-checkbox-group v-model="selectedKubernetesContextKeys" class="kubernetes-context-options">
        <el-checkbox v-for="item in selectableKubernetesConfigs" :key="kubernetesContextKey(item)" :value="kubernetesContextKey(item)">
          <span><strong>{{ item.context }}<small v-if="item.currentContext">{{ $t('当前') }}</small></strong><code>{{ item.path }}</code><small>{{ item.cluster }} · {{ item.namespace || 'default' }} · {{ kubernetesConfigStatusLabel(item) }}</small></span>
        </el-checkbox>
      </el-checkbox-group>
      <div v-if="!selectableKubernetesConfigs.length" class="service-log-options__empty">{{ $t('没有可选择的 kubeconfig context，请确认 viron-monitor 对配置文件具有读取权限。') }}</div>
      <template #footer><el-button @click="kubernetesDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="savingKubernetes" @click="saveKubernetesConfiguration">{{ $t('保存并立即扫描') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="logDialog" align-center class="envman-dialog" :title="$t('关联服务日志')" width="600px">
      <p class="log-dialog-intro">{{ $t('日志仍由环境日志模块统一配置，这里只建立快捷关联。') }}</p>
      <el-checkbox-group v-model="selectedLogIds" class="service-log-options">
        <el-checkbox v-for="log in payload.logs" :key="log.id" :value="log.id"><span><strong>{{ log.name }}</strong><small>{{ log.connectionName }} · {{ log.filePaths.join(', ') }}</small></span></el-checkbox>
      </el-checkbox-group>
      <div v-if="!payload.logs.length" class="service-log-options__empty">{{ $t('当前环境还没有日志配置，请先在“日志”页面添加。') }}</div>
      <template #footer><el-button @click="logDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveLogLinks">{{ $t('保存关联') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="alertSettingsDialog" align-center class="envman-dialog monitor-alert-settings-dialog" :title="$t('监控告警设置')" width="720px">
      <section class="monitor-alert-settings">
        <header>
          <div><strong>{{ $t('启用当前环境的监控告警') }}</strong><p>{{ $t('连续两次采集达到条件后触发，连续两次恢复正常后解除。') }}</p></div>
          <el-switch v-model="alertSettingsForm.enabled" />
        </header>
        <div class="monitor-alert-rule-list" :class="{ 'is-disabled': !alertSettingsForm.enabled }">
          <article class="is-switch-rule">
            <el-checkbox v-model="alertSettingsForm.hostOfflineEnabled">{{ $t('宿主机离线') }}</el-checkbox>
            <span>{{ $t('连续两次无法拉取监控数据，或采集数据持续未更新时告警') }}</span>
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.cpuEnabled">CPU</el-checkbox>
            <span>{{ $t('使用率达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.cpuThreshold" :min="1" :max="100" suffix="%" />
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.memoryEnabled">{{ $t('内存') }}</el-checkbox>
            <span>{{ $t('使用率达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.memoryThreshold" :min="1" :max="100" suffix="%" />
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.diskUsageEnabled">{{ $t('磁盘使用率') }}</el-checkbox>
            <span>{{ $t('任一挂载点达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.diskUsageThreshold" :min="1" :max="100" suffix="%" />
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.temperatureEnabled">{{ $t('温度') }}</el-checkbox>
            <span>{{ $t('最高温度达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.temperatureThreshold" :min="1" :max="200" suffix="°C" />
          </article>
          <article class="is-switch-rule">
            <el-checkbox v-model="alertSettingsForm.diskMissingEnabled">{{ $t('磁盘挂载变化') }}</el-checkbox>
            <span>{{ $t('磁盘新增、消失或恢复挂载连续确认两次后通知') }}</span>
          </article>
          <article class="is-switch-rule">
            <el-checkbox v-model="alertSettingsForm.deploymentStatusEnabled">{{ $t('部署节点状态') }}</el-checkbox>
            <span>{{ $t('已纳管节点进入停止或异常状态时告警') }}</span>
          </article>
        </div>
        <section class="monitor-alert-exclusions">
          <div>
            <strong>{{ $t('排除磁盘') }}</strong>
            <p>{{ $t('排除后不检查该磁盘的使用率和挂载变化。当前采集已自动过滤虚拟文件系统。') }}</p>
          </div>
          <el-select v-model="alertSettingsForm.excludedDisks" multiple filterable collapse-tags collapse-tags-tooltip :placeholder="$t('选择不需要监控的临时或可移动磁盘')">
            <el-option v-for="option in monitorDiskOptions" :key="option.key" :label="option.label" :value="option.key" />
          </el-select>
        </section>
      </section>
      <template #footer><el-button @click="alertSettingsDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="savingAlertSettings" @click="saveAlertSettings">{{ $t('保存告警设置') }}</el-button></template>
    </el-dialog>

    <MaintenanceBatchProgress :m="maintenance" />

  </section>
</template>

<style>
.maintenance-batch-bar {
  position: sticky;
  bottom: 0;
  z-index: 4;
  min-height: 3rem;
  padding: .625rem .875rem;
  border-block-start: 1px solid var(--ink-100);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .5rem .75rem;
  background: var(--surface);
}
.maintenance-batch-bar strong { margin-right: auto; font-size: .8125rem; }
.deployment-select-all { grid-column: 1 / -1; display: flex; align-items: center; gap: .5rem; color: var(--ink-500); font-size: .75rem; }
.deployment-select { display: inline-flex; align-items: center; margin-right: .375rem; }
.maintenance-console {
  --ops-green: var(--color-accent-strong);
  --ops-blue: var(--color-info);
  --ops-amber: var(--color-warning);
  --ops-red: var(--color-danger);
  height: 100%;
  min-height: 0;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  color: var(--color-ink);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-body);
}

.maintenance-chrome {
  min-width: 0;
  display: grid;
  background: var(--surface);
}
.maintenance-switcher {
  min-width: 0;
  min-height: 2.75rem;
  padding: .5rem .875rem .375rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
}
.maintenance-switcher__primary {
  flex: 0 1 auto;
  min-width: 0;
  padding: 3px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  display: grid;
  grid-template-columns: repeat(2, minmax(5.25rem, 1fr));
  gap: 3px;
  background: color-mix(in srgb, var(--ink-100) 55%, var(--surface));
}
.maintenance-switcher__primary button {
  min-width: 0;
  min-height: 2.125rem;
  padding: 0 .5rem;
  border: 0;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .25rem;
  background: transparent;
  color: var(--ink-500);
  font-size: .6875rem;
  font-weight: 650;
  cursor: pointer;
}
.maintenance-switcher__primary button.is-active {
  background: var(--surface);
  color: var(--teal-700);
  box-shadow: 0 1px 5px rgba(8, 22, 25, .1);
}
.maintenance-switcher small {
  min-width: 1.125rem;
  height: 1.125rem;
  padding: 0 .3rem;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: .625rem;
  font-weight: 700;
}
.maintenance-switcher__primary button.is-active small { background: var(--teal-50); color: var(--teal-700); }
.maintenance-switcher small.is-alert { background: color-mix(in srgb, var(--ops-amber) 22%, var(--surface)); color: var(--ops-amber); }
.maintenance-switcher button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.maintenance-toolbar {
  min-width: 0;
  min-height: 3.25rem;
  padding: .5rem .875rem;
  border-block-start: 1px solid var(--ink-100);
  border-block-end: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: .625rem 1rem;
  background: var(--surface);
}
.maintenance-toolbar__identity { min-width: 0; display: flex; align-items: center; gap: .625rem; }
.maintenance-toolbar__identity > span {
  width: 2.125rem;
  height: 2.125rem;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--teal-500) 32%, var(--ink-100));
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--teal-50);
  color: var(--teal-700);
}
.maintenance-toolbar__identity > div { min-width: 0; }

.maintenance-toolbar h2 {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-display);
  font-size: .9375rem;
  font-style: normal;
  font-weight: 750;
  line-height: 1.2;
}
.maintenance-toolbar__identity p { margin: .1875rem 0 0; color: var(--ink-400); font-size: .625rem; }

.maintenance-toolbar .el-button { white-space: nowrap; }
.maintenance-toolbar__actions { display: flex; align-items: center; gap: .5rem; }
.maintenance-toolbar__actions .el-button + .el-button { margin-left: 0; }

.maintenance-summary {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .25rem 1rem;
  color: var(--ink-500);
  font-variant-numeric: tabular-nums;
}

.maintenance-summary span {
  min-width: 0;
  min-height: 1.875rem;
  padding-inline: .625rem;
  border-inline-start: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  gap: .125rem .375rem;
}

.maintenance-summary span:first-child { border-inline-start: 0; }
.maintenance-summary i { grid-row: 1 / -1; }
.maintenance-summary strong { color: var(--ink-800); font-family: var(--font-mono); font-size: .75rem; line-height: 1; }
.maintenance-summary small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .625rem; }
.maintenance-summary i,
.host-index__row i { width: .375rem; height: .375rem; border-radius: 50%; background: var(--ink-200); }
.is-green,
.host-index__row i.is-online,
.host-index__row i.is-ready { background: var(--ops-green) !important; }
.is-amber,
.host-index__row i.is-offline,
.host-index__row i.is-error { background: var(--ops-amber) !important; }
.is-blue { background: var(--ops-blue) !important; }
.is-muted,
.host-index__row i.is-missing,
.host-index__row i.is-unknown { background: var(--ink-200) !important; }

.maintenance-layout { min-height: 0; overflow: auto; background: var(--surface); }
.maintenance-directory {
  min-height: 0;
  height: 18rem;
  max-height: 18rem;
  border-block-end: 1px solid var(--ink-100);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--ink-50) 54%, var(--surface));
}

.directory-group { min-height: 0; flex: 1 1 auto; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
.host-index__row i.is-expired, .host-index__row i.is-expiring, .host-index__row i.is-mismatch { background: var(--ops-amber) !important; }
.host-index__row i.is-ok { background: var(--ops-green) !important; }
.host-index__row i.is-unbound, .host-index__row i.is-failed { background: var(--ink-200) !important; }
.status-seal.is-expired, .status-seal.is-expiring, .status-seal.is-mismatch { color: var(--ops-amber); }
.status-seal.is-ok { color: var(--ops-green); }
.directory-group > header {
  min-height: 2.75rem;
  padding-inline: .875rem;
  border-block-end: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  gap: .5rem;
  background: color-mix(in srgb, var(--surface) 72%, transparent);
}
.directory-group h3 { min-width: 0; margin: 0; flex: 1; color: var(--ink-700); font-size: .6875rem; font-weight: 750; line-height: 1.2; }
.directory-group > header > svg { color: var(--ink-400); }
.directory-group > header > span {
  min-width: 1.5rem;
  height: 1.375rem;
  padding-inline: .375rem;
  border-radius: .6875rem;
  display: grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: .5625rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.directory-list { min-height: 0; padding: .4375rem; overflow: auto; display: grid; align-content: start; gap: .125rem; }
.service-index__row,
.host-index__row {
  position: relative;
  width: 100%;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  display: grid;
  grid-template-columns: 1.5rem minmax(0, 1fr) 1.75rem;
  align-items: center;
  background: transparent;
  color: var(--ink-600);
  transition: background-color var(--dur-micro) var(--ease-out), border-color var(--dur-micro) var(--ease-out), opacity var(--dur-micro) var(--ease-out);
}
.service-index__row { min-height: 3.25rem; }
.host-index__row { min-height: 2.875rem; }
.service-index__row.is-active,
.host-index__row.is-active { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); color: var(--teal-700); }
.service-index__row.is-dragging,
.host-index__row.is-dragging { opacity: .42; }
.service-index__row.is-drop-before::before,
.host-index__row.is-drop-before::before,
.service-index__row.is-drop-after::after,
.host-index__row.is-drop-after::after { content: ""; position: absolute; z-index: 2; inset-inline: .375rem; height: 2px; border-radius: 2px; background: var(--teal-500); }
.service-index__row.is-drop-before::before,
.host-index__row.is-drop-before::before { top: -2px; }
.service-index__row.is-drop-after::after,
.host-index__row.is-drop-after::after { bottom: -2px; }
.directory-row__grip,
.directory-row__menu {
  width: 1.5rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--ink-300);
}
.directory-row__grip,
.directory-row__menu { opacity: 0; }
.directory-row__grip { cursor: grab; }
.service-index__row:hover .directory-row__grip,
.service-index__row:hover .directory-row__menu,
.service-index__row:focus-within .directory-row__grip,
.service-index__row:focus-within .directory-row__menu,
.host-index__row:hover .directory-row__grip,
.host-index__row:hover .directory-row__menu,
.host-index__row:focus-within .directory-row__grip,
.host-index__row:focus-within .directory-row__menu,
.directory-row__grip:focus-visible,
.directory-row__menu:focus-visible { opacity: 1; }
.directory-row__grip:active { cursor: grabbing; }
.directory-row__grip.is-disabled,
.directory-row__menu:disabled { opacity: .45; cursor: not-allowed; }
.directory-row__spacer { width: 1.5rem; }
.directory-row__main {
  min-width: 0;
  min-height: inherit;
  padding: .375rem .25rem;
  border: 0;
  display: grid;
  align-items: center;
  gap: .5rem;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.service-index__row .directory-row__main { grid-template-columns: 2rem minmax(0, 1fr); }
.host-index__row .directory-row__main { grid-template-columns: 1rem minmax(0, 1fr) auto; }
.directory-row__menu-target { width: 1.75rem; height: 2rem; display: block; }
.directory-row__menu { width: 1.75rem; cursor: pointer; }
.directory-row__main:focus-visible,
.directory-row__menu:focus-visible,
.service-stage__actions > button:not(.el-button):focus-visible,
.deployment-card__tools button:focus-visible,
.deployment-card footer button:focus-visible,
.service-log-ribbon button:focus-visible,
.script-action-button:focus-visible,
.script-action-add:focus-visible,
.script-icon-picker button:focus-visible,
.script-action-manager__list article > button:focus-visible,
.deployment-empty-action:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.directory-row__main > span { min-width: 0; }
.directory-row__main > span:not(.service-mark) { display: grid; gap: .125rem; }
.service-index__row strong,
.host-index__row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .6875rem; }
.service-index__row small,
.host-index__row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-400); font-size: .5625rem; }
.service-mark {
  width: 2rem;
  height: 2rem;
  border-radius: 7px;
  display: grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-400);
}
.service-mark.is-running { background: var(--teal-100); color: var(--teal-700); }
.service-mark.is-degraded { background: var(--amber-100); color: var(--amber-600); }
.directory-empty { min-height: 3rem; padding-inline: .75rem; display: flex; align-items: center; gap: .5rem; color: var(--ink-400); font-size: .625rem; }

.maintenance-workspace { min-width: 0; min-height: 0; padding: 1rem; overflow: visible; background: var(--surface); }
.host-observatory {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
}
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
.host-observatory:has(> .host-observatory__pane.is-discovery) {
  min-height: 100%;
  height: auto;
  grid-template-rows: auto auto auto;
}
.host-observatory__pane.is-discovery { overflow: visible; }
.discovery-service-picker { display: grid; gap: .375rem; }
.discovery-service-picker button {
  width: 100%;
  min-height: 3.25rem;
  padding: .5rem .75rem;
  border: 1px solid var(--color-rule);
  border-radius: 8px;
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  align-items: center;
  gap: .625rem;
  background: var(--color-paper);
  color: var(--color-ink);
  text-align: start;
  cursor: pointer;
  transition: border-color var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out);
}
.discovery-service-picker button > span:last-child { min-width: 0; display: grid; gap: .125rem; }
.discovery-service-picker strong { overflow: hidden; font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.discovery-service-picker small { overflow: hidden; color: var(--color-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.service-stage__header,
.host-observatory > header {
  min-width: 0;
  padding-block-end: var(--space-md);
  border-block-end: 1px solid var(--color-rule);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-md);
}
.host-observatory > header { border-block-end: 0; }
.service-stage__header > div:first-child,
.host-observatory > header > div { min-width: 0; }
.service-title-line { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
.service-stage__header h3,
.host-observatory h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: var(--font-display); font-size: 1rem; font-style: normal; font-weight: 750; line-height: 1.2; }
.service-stage__header p,
.host-observatory p { margin: var(--space-2xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); line-height: 1.5; }
.host-observatory p.deployment-warning { color: var(--ops-red); }
.monitor-install-path {
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-block-start: var(--space-xs);
  overflow: hidden;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-observatory__actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.host-observatory__actions .el-button { margin: 0; }
.host-observatory__more {
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: var(--color-paper);
  color: var(--color-ink-soft);
  cursor: pointer;
}
.status-seal {
  width: fit-content;
  padding: var(--space-2xs) var(--space-xs);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.status-seal.is-running { border-color: var(--color-accent); color: var(--ops-green); }
.status-seal.is-degraded { border-color: var(--color-warning); color: var(--ops-amber); }
.service-stage__actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.service-stage__actions > button:not(.el-button),
.deployment-card__tools button,
.deployment-card footer button {
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: var(--color-paper-raised);
  color: var(--color-muted);
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.service-stage__actions > button:not(.el-button):active,
.deployment-card__tools button:active,
.deployment-card footer button:active { transform: translateY(1px); }
.service-script-ribbon {
  padding-block: var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs);
}
.service-script-ribbon__label { margin-inline-end: var(--space-2xs); display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); }
.script-action-button,
.script-action-add {
  min-width: 0;
  min-height: 2rem;
  padding: var(--space-2xs) var(--space-sm);
  border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-rule));
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font: inherit;
  font-size: var(--text-xs);
  font-weight: 700;
  cursor: pointer;
  transition: border-color var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.script-action-button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.script-action-button:hover:not(:disabled) { border-color: var(--color-accent); background: var(--color-paper-raised); }
.script-action-button:active:not(:disabled), .script-action-add:active { transform: translateY(1px); }
.script-action-button:disabled { opacity: .5; cursor: not-allowed; }
.script-action-add { border-style: dashed; background: transparent; color: var(--color-muted); font-weight: 600; }
.service-log-ribbon {
  padding-block: var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs);
  color: var(--color-muted);
  font-size: var(--text-xs);
}
.service-log-ribbon button {
  min-height: 2rem;
  padding-inline: var(--space-xs);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper);
  color: var(--color-ink-soft);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.service-log-ribbon button:active { transform: translateY(1px); }
.service-log-ribbon button small { margin-inline-start: var(--space-2xs); color: var(--color-muted); }
.deployment-grid { padding-block-start: var(--space-md); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); }
.deployment-card {
  min-width: 0;
  min-height: 14.5rem;
  padding: var(--space-md);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  background: var(--color-paper);
  color: var(--color-ink);
  box-shadow: none;
}
.deployment-card > header { display: flex; align-items: center; gap: var(--space-xs); }
.deployment-provider {
  padding: var(--space-2xs) var(--space-xs);
  border-radius: var(--radius-control);
  background: var(--color-rule);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  line-height: 1;
}
.deployment-status { display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); }
.deployment-status i { width: .375rem; height: .375rem; border-radius: 50%; background: currentColor; }
.deployment-card.is-running .deployment-status { color: var(--ops-green); }
.deployment-card.is-degraded .deployment-status,
.deployment-card.is-stopped .deployment-status { color: var(--ops-amber); }
.deployment-card__tools { margin-inline-start: auto; display: flex; gap: var(--space-2xs); }
.deployment-card__tools button { width: 2rem; height: 2rem; border-color: transparent; background: transparent; }
.deployment-card__identity { min-width: 0; padding-block: var(--space-md) var(--space-sm); display: grid; gap: var(--space-2xs); }
.deployment-card__identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-base); }
.deployment-card code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); line-height: 1.35; }
.deployment-card dl { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.deployment-card dl div { min-width: 0; }
.deployment-card dt { margin-block-end: var(--space-2xs); color: var(--color-muted); font-size: var(--text-2xs); }
.deployment-card dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.deployment-script-actions { margin-block-start: var(--space-sm); display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.script-action-button.is-node { min-height: 1.875rem; padding-inline: var(--space-xs); background: var(--color-paper-muted); font-size: var(--text-2xs); }
.deployment-warning { margin: var(--space-xs) 0 0; color: var(--ops-red); font-size: var(--text-xs); }
.deployment-card > footer { margin-block-start: var(--space-sm); padding-block-start: var(--space-sm); border-block-start: 1px solid var(--color-rule); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.deployment-card footer > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-2xs); }
.deployment-card footer > div { display: flex; gap: var(--space-2xs); }
.deployment-card footer button { width: 2rem; height: 2rem; }
.deployment-action-note { min-width: 0; color: var(--color-muted); font-size: var(--text-2xs); text-align: end; }
.deployment-empty-action {
  min-height: 3.5rem;
  padding: var(--space-sm) var(--space-md);
  border: 1px dashed var(--color-rule-strong);
  border-radius: var(--radius-card);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  background: var(--color-paper);
  color: var(--color-muted);
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.deployment-empty-action strong { font-size: var(--text-sm); }
.deployment-empty-action:active { transform: translateY(1px); }

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
.host-observatory__empty code { display: block; width: fit-content; max-width: 100%; margin-block-start: var(--space-xs); padding: var(--space-xs) var(--space-sm); overflow-wrap: anywhere; border-radius: var(--radius-control); background: var(--color-ink); color: var(--color-sidebar-ink); font-family: var(--font-mono); font-size: var(--text-2xs); }
.service-stage__actions > button:not(.el-button):disabled,
.deployment-card__tools button:disabled,
.deployment-card footer button:disabled,
.service-log-ribbon button:disabled,
.deployment-empty-action:disabled { opacity: .55; cursor: not-allowed; }

.workspace-empty,
.maintenance-zero-state {
  min-height: 12rem;
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--space-sm);
  color: var(--color-muted);
  text-align: center;
}
.workspace-empty strong,
.maintenance-zero-state h3 { margin: 0; color: var(--color-ink-soft); font-size: var(--text-sm); }
.maintenance-zero-state { grid-row: 2; }
.deployment-form-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); }
.log-dialog-intro { margin: 0 0 var(--space-sm); color: var(--color-muted); font-size: var(--text-sm); }
.service-log-options { display: grid; gap: var(--space-xs); }
.service-log-options .el-checkbox { height: auto; margin: 0; padding: var(--space-sm); border: 1px solid var(--color-rule); border-radius: var(--radius-control); align-items: flex-start; }
.service-log-options .el-checkbox__label { min-width: 0; }
.service-log-options span { min-width: 0; display: grid; gap: var(--space-2xs); }
.service-log-options strong { font-size: var(--text-sm); }
.service-log-options small { overflow-wrap: anywhere; color: var(--color-muted); font-size: var(--text-xs); }
.service-log-options__empty { padding: var(--space-lg); border: 1px dashed var(--color-rule-strong); border-radius: var(--radius-control); text-align: center; color: var(--color-muted); font-size: var(--text-xs); }
.kubernetes-dialog__intro { margin: 0 0 var(--space-md); color: var(--color-muted); font-size: var(--text-sm); line-height: 1.6; }
.kubernetes-context-options { max-height: min(28rem, 55dvh); overflow: auto; display: grid; gap: var(--space-xs); }
.kubernetes-context-options .el-checkbox { width: 100%; height: auto; margin: 0; padding: var(--space-sm); border: 1px solid var(--color-rule); border-radius: var(--radius-control); align-items: flex-start; }
.kubernetes-context-options .el-checkbox__label { min-width: 0; flex: 1; }
.kubernetes-context-options .el-checkbox__label > span { min-width: 0; display: grid; gap: var(--space-2xs); }
.kubernetes-context-options strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink-soft); font-size: var(--text-sm); }
.kubernetes-context-options strong small { margin-inline-start: var(--space-xs); color: var(--color-info); font-size: var(--text-2xs); }
.kubernetes-context-options code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.kubernetes-context-options span > small { color: var(--color-muted); font-size: var(--text-2xs); }
.script-action-manager-dialog .el-dialog__body,
.script-action-result-dialog .el-dialog__body { max-height: calc(100dvh - 10rem); overflow: auto; }
.script-action-manager { display: grid; gap: var(--space-md); }
.script-action-manager > header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); }
.script-action-manager > header > div { min-width: 0; }
.script-action-manager > header strong { font-size: var(--text-base); }
.script-action-manager > header p { margin: var(--space-2xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); line-height: 1.5; }
.script-action-manager__list { border-block-start: 1px solid var(--color-rule); display: grid; }
.script-action-manager__list article {
  min-width: 0;
  min-height: 3.5rem;
  padding: var(--space-xs) var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: grid;
  grid-template-columns: 2.125rem minmax(0, 1fr) 2rem 2rem;
  align-items: center;
  gap: var(--space-xs);
}
.script-action-manager__list article.is-editing { background: var(--color-accent-soft); }
.script-action-manager__list article > span { width: 2.125rem; height: 2.125rem; border-radius: var(--radius-control); display: grid; place-items: center; background: var(--color-ink); color: var(--color-sidebar-ink); }
.script-action-manager__list article > div { min-width: 0; display: grid; gap: var(--space-2xs); }
.script-action-manager__list article strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.script-action-manager__list article small { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.script-action-manager__list article > button,
.script-action-editor > header button {
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}
.script-action-manager__list article > button:hover { background: var(--color-paper-muted); color: var(--color-ink); }
.script-action-manager__list article > button.is-danger:hover { background: var(--color-danger-soft); color: var(--color-danger); }
.script-action-manager__empty { min-height: 9rem; border: 1px dashed var(--color-rule-strong); border-radius: var(--radius-card); display: grid; place-items: center; align-content: center; gap: var(--space-xs); color: var(--color-muted); text-align: center; }
.script-action-manager__empty strong { color: var(--color-ink-soft); font-size: var(--text-sm); }
.script-action-manager__empty p { margin: 0; font-size: var(--text-xs); }
.script-action-editor { padding: var(--space-md); border: 1px solid var(--color-rule-strong); border-radius: var(--radius-card); background: var(--color-paper-muted); }
.script-action-editor > header { margin-block-end: var(--space-md); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.script-action-editor > header strong { font-size: var(--text-base); }
.script-action-editor > header button { font-size: var(--text-xl); line-height: 1; }
.script-icon-picker { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.script-icon-picker button { width: 2.5rem; height: 2.5rem; padding: 0; border: 1px solid var(--color-rule); border-radius: var(--radius-control); display: grid; place-items: center; background: var(--color-paper-raised); color: var(--color-muted); cursor: pointer; }
.script-icon-picker button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); box-shadow: 0 0 0 2px var(--color-paper-raised), 0 0 0 4px color-mix(in srgb, var(--color-accent) 25%, transparent); }
.script-body-input textarea { min-height: 14rem; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.6; tab-size: 2; }
.script-action-editor__hint { display: block; margin-block-start: var(--space-xs); color: var(--color-muted); font-size: var(--text-2xs); line-height: 1.5; }
.script-action-editor > footer { display: flex; justify-content: flex-end; gap: var(--space-xs); }
.script-action-results { display: grid; gap: var(--space-sm); }
.script-action-results > header { padding: var(--space-md); border: 1px solid var(--color-rule); border-radius: var(--radius-card); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-sm); background: var(--color-paper-muted); }
.script-action-results > header.is-success { border-color: color-mix(in srgb, var(--ops-green) 45%, var(--color-rule)); }
.script-action-results > header.is-warning { border-color: color-mix(in srgb, var(--ops-amber) 55%, var(--color-rule)); }
.script-action-results > header > span { width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; background: var(--color-accent-soft); color: var(--ops-green); }
.script-action-results > header.is-warning > span { background: var(--color-warning-soft); color: var(--ops-amber); }
.script-action-results > header strong { font-size: var(--text-base); }
.script-action-results > header p { margin: var(--space-2xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); }
.script-action-results > article { border: 1px solid var(--color-rule); border-radius: var(--radius-card); overflow: hidden; background: var(--color-paper); }
.script-action-results > article.is-error { border-color: color-mix(in srgb, var(--ops-red) 45%, var(--color-rule)); }
.script-action-results > article > header { padding: var(--space-sm); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-xs); }
.script-action-results > article > header > span { color: var(--ops-green); }
.script-action-results > article.is-error > header > span { color: var(--ops-red); }
.script-action-results > article > header > div { min-width: 0; display: grid; gap: var(--space-2xs); }
.script-action-results > article > header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.script-action-results > article > header small { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.script-action-result__message { margin: 0; padding: 0 var(--space-sm) var(--space-sm); color: var(--ops-red); font-size: var(--text-xs); }
.script-action-results details { border-block-start: 1px solid var(--color-rule); }
.script-action-results summary { padding: var(--space-xs) var(--space-sm); display: flex; align-items: center; gap: var(--space-xs); color: var(--color-muted); font-size: var(--text-xs); cursor: pointer; }
.script-action-results summary small { color: var(--ops-amber); }
.script-action-results details > div { padding: var(--space-sm); border-block-start: 1px solid var(--color-rule); background: var(--color-ink); color: var(--color-sidebar-ink); }
.script-action-results details > div > strong { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); text-transform: uppercase; }
.script-action-results pre { max-height: 18rem; margin: var(--space-xs) 0 0; overflow: auto; color: inherit; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.monitor-install-progress-dialog .el-dialog__body { max-height: calc(100dvh - 10rem); overflow: auto; }
.monitor-install-progress { display: grid; gap: var(--space-md); }
.monitor-install-progress__summary {
  min-width: 0;
  padding: var(--space-md);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-sm);
  background: var(--color-paper-muted);
}
.monitor-install-progress__summary.is-success { border-color: var(--color-accent); background: var(--color-accent-soft); }
.monitor-install-progress__summary.is-error { border-color: var(--color-danger); background: var(--color-danger-soft); }
.monitor-install-progress__status { width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; background: var(--color-info-soft); color: var(--color-info); }
.monitor-install-progress__summary.is-success .monitor-install-progress__status { background: var(--color-accent); color: var(--color-paper); }
.monitor-install-progress__summary.is-error .monitor-install-progress__status { background: var(--color-danger); color: var(--color-paper); }
.monitor-install-progress__summary > div { min-width: 0; }
.monitor-install-progress__summary strong { display: block; font-size: var(--text-sm); }
.monitor-install-progress__summary p { margin: var(--space-2xs) 0 0; overflow-wrap: anywhere; color: var(--color-ink-soft); font-size: var(--text-xs); }
.monitor-install-progress__summary > time { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); font-variant-numeric: tabular-nums; }
.monitor-install-progress__target { margin: 0; padding: 0 var(--space-xs); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.monitor-install-progress__target div { min-width: 0; }
.monitor-install-progress__target dt { margin-block-end: var(--space-2xs); color: var(--color-muted); font-size: var(--text-2xs); }
.monitor-install-progress__target dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink-soft); font-size: var(--text-xs); }
.monitor-install-progress__target code { font-family: var(--font-mono); font-size: var(--text-2xs); }
.monitor-install-progress__bar { padding-inline: var(--space-xs); }
.monitor-install-progress__bar .el-progress__text { min-width: 2.75rem; color: var(--color-ink-soft); font-family: var(--font-mono); font-size: var(--text-xs) !important; }
.monitor-install-steps { margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-xs); list-style: none; }
.monitor-install-steps li { min-width: 0; min-height: 4rem; padding: var(--space-sm); border: 1px solid var(--color-rule); border-radius: var(--radius-control); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-xs); background: var(--color-paper); color: var(--color-muted); }
.monitor-install-steps li > span { width: 1.5rem; height: 1.5rem; border: 1px solid var(--color-rule-strong); border-radius: 50%; display: grid; place-items: center; background: var(--color-paper-muted); color: var(--color-muted); }
.monitor-install-steps li > span i { font-family: var(--font-mono); font-size: var(--text-2xs); font-style: normal; }
.monitor-install-steps li > div { min-width: 0; display: grid; gap: var(--space-2xs); }
.monitor-install-steps li strong { color: var(--color-ink-soft); font-size: var(--text-xs); line-height: 1.25; }
.monitor-install-steps li small { color: var(--color-muted); font-size: var(--text-2xs); line-height: 1.35; }
.monitor-install-steps li.is-complete { border-color: var(--color-accent); background: var(--color-accent-soft); }
.monitor-install-steps li.is-complete > span { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-paper); }
.monitor-install-steps li.is-active { border-color: var(--color-info); box-shadow: inset 0 0 0 1px var(--color-info); }
.monitor-install-steps li.is-active > span { border-color: var(--color-info); background: var(--color-info-soft); color: var(--color-info); }
.monitor-install-steps li.is-error { border-color: var(--color-danger); background: var(--color-danger-soft); }
.monitor-install-steps li.is-error > span { border-color: var(--color-danger); background: var(--color-danger); color: var(--color-paper); }
.monitor-install-logs { border-block: 1px solid var(--color-rule); }
.monitor-install-logs > summary { min-height: 2.75rem; padding-inline: var(--space-xs); display: flex; align-items: center; gap: var(--space-xs); color: var(--color-ink-soft); font-size: var(--text-xs); font-weight: 700; cursor: pointer; list-style: none; }
.monitor-install-logs > summary::-webkit-details-marker { display: none; }
.monitor-install-logs > summary small { margin-inline-start: auto; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); font-weight: 500; }
.monitor-install-logs > summary > svg { color: var(--color-muted); transition: transform var(--dur-micro) var(--ease-out); }
.monitor-install-logs[open] > summary > svg { transform: rotate(90deg); }
.monitor-install-logs__body { max-height: 15rem; padding: var(--space-sm); overflow: auto; border-block-start: 1px solid var(--color-rule); background: var(--color-ink); color: var(--color-sidebar-ink); }
.monitor-install-logs__body p { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-sm); font-family: var(--font-mono); font-size: var(--text-2xs); line-height: 1.65; }
.monitor-install-logs__body p + p { margin-block-start: var(--space-2xs); }
.monitor-install-logs__body time { color: var(--color-sidebar-muted); font-variant-numeric: tabular-nums; }
.monitor-install-logs__body code { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; color: inherit; font-family: inherit; }
.monitor-install-logs__body p.is-output code { color: var(--color-sidebar-muted); }
.monitor-install-progress__loading { min-height: 12rem; display: flex; align-items: center; justify-content: center; gap: var(--space-xs); color: var(--color-muted); font-size: var(--text-sm); }
.is-spinning { animation: maintenance-spin .8s linear infinite; }
@keyframes maintenance-spin { to { transform: rotate(360deg); } }
.monitor-alert-settings { display: grid; gap: 1rem; }
.monitor-alert-settings > header { min-height: 4rem; padding: .875rem 1rem; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--ink-50); display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.monitor-alert-settings > header strong, .monitor-alert-settings > header p { display: block; margin: 0; }
.monitor-alert-settings > header strong { color: var(--ink-800); font-size: .875rem; }
.monitor-alert-settings > header p { margin-top: .25rem; color: var(--ink-400); font-size: .6875rem; }
.monitor-alert-rule-list {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content auto;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  overflow: hidden;
  transition: opacity .15s ease;
}
.monitor-alert-rule-list.is-disabled { opacity: .5; pointer-events: none; }
.monitor-alert-rule-list article {
  min-height: 3.5rem;
  padding: .625rem .875rem;
  border-block-end: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: center;
  gap: .625rem .75rem;
}
.monitor-alert-rule-list article:last-child { border-block-end: 0; }
.monitor-alert-rule-list article > span { min-width: 0; color: var(--ink-500); font-size: .75rem; }
.monitor-alert-rule-list article:not(.is-switch-rule) > span { grid-column: 3; justify-self: end; }
.monitor-alert-rule-list article.is-switch-rule > span { grid-column: 2 / -1; }
.monitor-alert-rule-list article.is-named-rule > strong { color: var(--ink-800); font-size: .875rem; font-weight: 650; }
.monitor-alert-rule-list article.is-named-rule > span { grid-column: 3; justify-self: end; }
.monitor-alert-rule-list article.is-named-rule .el-select { grid-column: 4; justify-self: start; width: 7rem; }
.monitor-alert-rule-list article .animated-counter { grid-column: 4; justify-self: start; }
.monitor-alert-settings .el-select { width: 100%; }
.monitor-alert-exclusions {
  display: grid;
  gap: .75rem;
  padding: .875rem 1rem;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: var(--ink-50);
}
.monitor-alert-exclusions strong,
.monitor-alert-exclusions p { display: block; margin: 0; }
.monitor-alert-exclusions strong { color: var(--ink-800); font-size: .875rem; }
.monitor-alert-exclusions p { margin-top: .25rem; color: var(--ink-400); font-size: .6875rem; line-height: 1.5; }

@media (hover: hover) and (pointer: fine) {
  .service-index__row:hover:not(.is-active),
  .host-index__row:hover:not(.is-active) { background: var(--ink-50); }
  .service-index__row:hover .directory-row__grip,
  .service-index__row:hover .directory-row__menu,
  .host-index__row:hover .directory-row__grip,
  .host-index__row:hover .directory-row__menu { color: var(--ink-500); }
  .directory-row__grip:hover:not(.is-disabled),
  .directory-row__menu:hover:not(:disabled) { background: var(--surface); color: var(--teal-700); }
  .host-workspace-tabs button:hover:not(.is-active),
  .maintenance-switcher__primary button:hover:not(.is-active) { color: var(--ink-800); }
  .service-stage__actions > button:not(.el-button):hover,
  .deployment-card__tools button:hover,
  .deployment-card footer button:hover,
  .deployment-empty-action:hover,
  .discovery-service-picker button:hover { color: var(--ops-green); background: var(--color-accent-soft); }
  .discovery-service-picker button:hover { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); }
  .service-stage__actions > button:not(.el-button).is-danger:hover,
  .deployment-card__tools button.is-danger:hover { color: var(--ops-red); background: var(--color-danger-soft); }
}

@media (pointer: coarse) {
  .directory-row__grip,
  .directory-row__menu { opacity: 1; }
  .maintenance-console .el-button,
  .service-log-ribbon button,
  .script-action-button,
  .script-action-add,
  .directory-row__menu,
  .service-stage__actions > button:not(.el-button),
  .deployment-card__tools button,
  .deployment-card footer button,
  .host-workspace-tabs button { min-width: 2.75rem; min-height: 2.75rem; }
  .maintenance-switcher button { min-width: 2.75rem; min-height: 2.75rem; }
}

@media (min-width: 40rem) {
  .maintenance-summary span { padding-inline: var(--space-sm); grid-template-columns: auto auto minmax(0, 1fr); grid-template-rows: auto; gap: var(--space-xs); }
  .maintenance-summary i { grid-row: auto; }
  .maintenance-directory { height: 18rem; max-height: 18rem; }
  .deployment-form-grid { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }
}

@media (max-width: 39.999rem) {
  .maintenance-toolbar__actions { grid-column: 1 / -1; width: 100%; }
  .maintenance-toolbar__actions .el-button { flex: 1; }
  .monitor-alert-rule-list { grid-template-columns: minmax(0, 1fr); }
  .monitor-alert-rule-list article,
  .monitor-alert-rule-list article.is-switch-rule { grid-template-columns: minmax(0, 1fr); justify-items: start; }
  .monitor-alert-rule-list article:not(.is-switch-rule) > span,
  .monitor-alert-rule-list article.is-switch-rule > span,
  .monitor-alert-rule-list article.is-named-rule > span { grid-column: auto; justify-self: start; }
  .monitor-alert-rule-list article.is-named-rule .el-select { grid-column: auto; justify-self: start; }
  .monitor-alert-rule-list article .animated-counter { grid-column: auto; justify-self: start; }
  .host-observatory > header,
  .host-observatory__actions { width: 100%; }
  .host-observatory__actions .el-button { flex: 1 1 100%; }
  .monitor-install-progress__summary { grid-template-columns: auto minmax(0, 1fr); }
  .monitor-install-progress__summary > time { grid-column: 2; }
  .monitor-install-progress__target,
  .monitor-install-steps { grid-template-columns: minmax(0, 1fr); }
  .script-action-manager > header { align-items: stretch; flex-direction: column; }
  .script-action-manager > header .el-button { width: 100%; }
  .script-action-manager__list article { grid-template-columns: 2.125rem minmax(0, 1fr) 2.25rem 2.25rem; padding-inline: var(--space-xs); }
}

@media (min-width: 52rem) {
  .maintenance-layout { display: grid; grid-template-columns: 16.75rem minmax(0, 1fr); overflow: hidden; }
  .maintenance-directory { height: auto; max-height: none; border-inline-end: 1px solid var(--ink-100); border-block-end: 0; display: flex; }
  .maintenance-workspace { padding: var(--space-lg); overflow: auto; }
  .maintenance-workspace:has(.host-observatory) { overflow: hidden; display: flex; flex-direction: column; }
  .maintenance-workspace:has(.host-observatory) > .host-observatory { flex: 1 1 auto; min-height: 0; }
  .maintenance-workspace:has(.host-observatory__pane.is-discovery) { overflow: auto; display: block; }
  .deployment-grid { grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); }
}

@media (min-width: 60rem) {
  .maintenance-switcher,
  .maintenance-toolbar { padding-inline: 1rem; }
}

@media (prefers-reduced-motion: reduce) {
  .directory-row__menu,
  .service-stage__actions > button:not(.el-button),
  .deployment-card__tools button,
  .deployment-card footer button,
  .service-log-ribbon button,
  .script-action-button,
  .script-action-add,
  .script-icon-picker button,
  .deployment-empty-action,
  .host-workspace-tabs button { transition-duration: var(--dur-micro); transform: none !important; }
  .is-spinning { animation-duration: 1.4s; }
}
</style>
