<script setup lang="ts">
import { unref } from "vue";
import { FileText, Pencil, Play, RefreshCw, RotateCw, Settings2, Square, Terminal, Trash2 } from "@lucide/vue";
import { providerLabel } from "../../service-candidate-tree";
import type { Deployment } from "./types";

const { m, deployment } = defineProps<{ m: Record<string, any>; deployment: Deployment }>();
const emit = defineEmits<{ "open-log": [id: string]; "open-ssh": [id: string] }>();
const {
  payload, selectedService, selectedDeploymentIds, runningAction, runningScriptActionId,
  statusLabel, deploymentIdentity, kubernetesMetric, formatPercent, formatBytes,
  formatDuration, formatTime, supportsMaintenanceActions, deploymentAllowsAction,
  unsupportedMaintenanceActionReason, toggleDeploymentSelection, openDeploymentEdit,
  removeDeployment, openScriptActionManager, executeScriptAction, resolveScriptActionIcon,
  runMaintenanceAction,
} = m;

function deploymentLogId() {
  const service = unref(selectedService);
  const logs = unref(payload).logs ?? [];
  const serviceLogIds = service?.logIds ?? [];
  return logs.find((log: { sshConnectionId: string; id: string }) => log.sshConnectionId === deployment.sshConnectionId && serviceLogIds.includes(log.id))?.id
    ?? logs.find((log: { sshConnectionId: string; id: string }) => log.sshConnectionId === deployment.sshConnectionId)?.id
    ?? serviceLogIds[0]
    ?? "";
}

function deploymentName() {
  return (deployment.displayName || deployment.externalId || "").trim();
}

function deploymentHostLine() {
  const host = deployment.host?.trim() || "";
  const name = deployment.sshConnectionName?.trim() || "";
  if (host && name && name !== host) return `${name} · ${host}`;
  return host || name;
}

function showDeploymentIdentity() {
  const identity = String(deploymentIdentity(deployment) ?? "").trim();
  if (!identity) return false;
  const name = deploymentName();
  const host = deploymentHostLine();
  return identity !== name && identity !== host && identity !== (deployment.host ?? "").trim() && identity !== (deployment.sshConnectionName ?? "").trim();
}
</script>

<template>
  <article class="deployment-card" :class="`is-${deployment.status}`">
    <header>
      <label v-if="payload.canOperate" class="deployment-select"><input type="checkbox" :checked="selectedDeploymentIds.includes(deployment.id)" @change="toggleDeploymentSelection(deployment.id)"></label>
      <span class="deployment-provider">{{ providerLabel(deployment.provider) }}</span>
      <span class="deployment-status" :title="deployment.state || undefined"><i></i>{{ statusLabel(deployment.status) }}</span>
      <div v-if="payload.canConfigure" class="deployment-card__tools">
        <button v-if="payload.scriptActionsSupported" type="button" :title="$t('管理节点功能按钮')" :aria-label="$t('管理节点功能按钮')" @click="openScriptActionManager(deployment)"><Settings2 :size="14" /></button>
        <button type="button" :title="$t('编辑部署节点')" :aria-label="$t('编辑部署节点')" @click="openDeploymentEdit(deployment)"><Pencil :size="14" /></button>
        <button type="button" class="is-danger" :title="$t('移除部署节点')" :aria-label="$t('移除部署节点')" @click="removeDeployment(deployment)"><Trash2 :size="14" /></button>
      </div>
    </header>
    <div class="deployment-card__body">
      <div class="deployment-card__identity">
        <strong>{{ deploymentName() || deployment.externalId }}</strong>
        <small v-if="deploymentHostLine()">{{ deploymentHostLine() }}</small>
        <code v-if="showDeploymentIdentity()">{{ deploymentIdentity(deployment) }}</code>
      </div>
      <dl class="deployment-card__metrics">
        <template v-if="deployment.provider === 'kubernetes'">
          <div><dt>{{ $t('期望副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'desiredReplicas') }}</dd></div>
          <div><dt>{{ $t('就绪副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'readyReplicas') }}</dd></div>
          <div><dt>{{ $t('可用副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'availableReplicas') }}</dd></div>
          <div><dt>{{ $t('已更新副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'updatedReplicas') }}</dd></div>
        </template>
        <template v-else>
          <div><dt>CPU</dt><dd>{{ formatPercent(deployment.metrics.cpuUsedPercent) }}</dd></div>
          <div><dt>{{ $t('内存') }}</dt><dd>{{ formatBytes(deployment.metrics.memoryBytes) }}</dd></div>
          <div><dt>{{ $t('运行时间') }}</dt><dd>{{ formatDuration(deployment.metrics.uptimeSeconds) }}</dd></div>
          <div><dt>{{ $t('重启次数') }}</dt><dd>{{ deployment.metrics.restartCount ?? '—' }}</dd></div>
        </template>
      </dl>
    </div>
    <div v-if="deployment.scriptActions.length" class="deployment-script-actions">
      <button v-for="action in deployment.scriptActions" :key="action.id" type="button" class="script-action-button is-node" :disabled="runningScriptActionId !== '' || selectedService.status !== 'active' || !deployment.connectionAvailable" @click="executeScriptAction(action)">
        <component :is="resolveScriptActionIcon(action.icon)" :size="14" />
        <span>{{ action.name }}</span>
        <RefreshCw v-if="runningScriptActionId === action.id" :size="12" class="is-spinning" />
      </button>
    </div>
    <p v-if="!deployment.connectionAvailable" class="deployment-warning">{{ $t('原 SSH 连接已删除或移出环境，请修复部署节点。') }}</p>
    <footer>
      <span>{{ formatTime(deployment.lastCheckedAt) }}</span>
      <div class="deployment-card__ops">
        <button type="button" :disabled="!deployment.sshConnectionId || !deployment.connectionAvailable" :title="$t('直连 SSH')" :aria-label="$t('直连 SSH')" @click="emit('open-ssh', deployment.sshConnectionId || '')"><Terminal :size="14" /></button>
        <button type="button" :disabled="!deploymentLogId()" :title="$t('节点日志')" :aria-label="$t('节点日志')" @click="emit('open-log', deploymentLogId())"><FileText :size="14" /></button>
        <template v-if="payload.canOperate && selectedService.status === 'active' && supportsMaintenanceActions(deployment.provider, deployment)">
          <button v-if="deploymentAllowsAction(deployment, 'start')" type="button" :disabled="runningAction !== '' || !deployment.connectionAvailable" :title="$t('启动')" :aria-label="$t('启动')" @click="runMaintenanceAction(deployment, 'start')"><Play :size="14" /></button>
          <button v-if="deploymentAllowsAction(deployment, 'stop')" type="button" :disabled="runningAction !== '' || !deployment.connectionAvailable" :title="$t('停止')" :aria-label="$t('停止')" @click="runMaintenanceAction(deployment, 'stop')"><Square :size="13" /></button>
          <button v-if="deploymentAllowsAction(deployment, 'restart')" type="button" :disabled="runningAction !== '' || !deployment.connectionAvailable" :title="$t('重启')" :aria-label="$t('重启')" @click="runMaintenanceAction(deployment, 'restart')"><RotateCw :size="14" :class="{ 'is-spinning': runningAction === `${deployment.id}:restart` }" /></button>
        </template>
      </div>
      <small v-if="!(payload.canOperate && selectedService.status === 'active' && supportsMaintenanceActions(deployment.provider, deployment)) && unsupportedMaintenanceActionReason(deployment.provider, deployment)" class="deployment-action-note">{{ unsupportedMaintenanceActionReason(deployment.provider, deployment) }}</small>
    </footer>
  </article>
</template>
