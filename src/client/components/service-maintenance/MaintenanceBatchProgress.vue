<script setup lang="ts">
import { Check, CircleAlert } from "@lucide/vue";
import { localizeMessage } from "../../i18n";

const { m } = defineProps<{ m: Record<string, any> }>();
const {
  payload,
  selectedDeploymentIds,
  activeWorkspace,
  runningAction,
  batchDialog,
  batchOperation,
  clearDeploymentSelection,
  runBatchMaintenanceAction,
  retryFailedBatchTargets,
} = m;
</script>

<template>
  <div v-if="payload.canOperate && selectedDeploymentIds.length && activeWorkspace === 'service'" class="maintenance-batch-bar">
    <strong>{{ selectedDeploymentIds.length }} {{ $t('节点') }}</strong>
    <el-button @click="clearDeploymentSelection">{{ $t('取消选择') }}</el-button>
    <el-button :disabled="runningAction !== ''" @click="runBatchMaintenanceAction('start')">{{ $t('批量启动') }}</el-button>
    <el-button :disabled="runningAction !== ''" @click="runBatchMaintenanceAction('stop')">{{ $t('批量停止') }}</el-button>
    <el-button type="primary" :disabled="runningAction !== ''" @click="runBatchMaintenanceAction('restart')">{{ $t('批量重启') }}</el-button>
  </div>

  <el-dialog append-to-body v-model="batchDialog" align-center class="envman-dialog" :title="$t('批量操作进度')" width="720px">
    <section v-if="batchOperation" class="script-action-results">
      <header :class="batchOperation.failed ? 'is-warning' : 'is-success'">
        <span><Check v-if="!batchOperation.failed" :size="18" /><CircleAlert v-else :size="18" /></span>
        <div><strong>{{ batchOperation.status }}</strong><p>{{ batchOperation.succeeded }} / {{ batchOperation.failed }}</p></div>
      </header>
      <article v-for="result in batchOperation.targets" :key="result.deploymentId" :class="result.ok ? 'is-success' : 'is-error'">
        <header><span><Check v-if="result.ok" :size="15" /><CircleAlert v-else :size="15" /></span><div><strong>{{ result.targetName }}</strong><small>{{ result.durationMs }} ms</small></div></header>
        <p v-if="result.message" class="script-action-result__message">{{ localizeMessage(result.message) }}</p>
      </article>
    </section>
    <template #footer>
      <el-button @click="batchDialog = false">{{ $t('关闭') }}</el-button>
      <el-button v-if="batchOperation?.failed" type="primary" :disabled="runningAction !== ''" @click="retryFailedBatchTargets">{{ $t('重试失败节点') }}</el-button>
    </template>
  </el-dialog>
</template>
