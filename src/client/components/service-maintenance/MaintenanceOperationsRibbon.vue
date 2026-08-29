<script setup lang="ts">
import { FileText, Plus, RefreshCw, Settings2, Zap } from "@lucide/vue";

const { m } = defineProps<{ m: Record<string, any> }>();
const emit = defineEmits<{ "open-log": [id: string] }>();
const {
  payload,
  selectedService,
  selectedLogs,
  runningScriptActionId,
  executeScriptAction,
  resolveScriptActionIcon,
  openScriptActionManager,
} = m;
</script>

<template>
  <div v-if="payload.scriptActionsSupported && (selectedService.scriptActions.length || payload.canConfigure)" class="service-script-ribbon">
    <span class="service-script-ribbon__label"><Zap :size="15" />{{ $t('服务功能') }}</span>
    <button
      v-for="action in selectedService.scriptActions"
      :key="action.id"
      type="button"
      class="script-action-button"
      :disabled="runningScriptActionId !== '' || selectedService.status !== 'active' || !selectedService.deployments.length || !payload.canOperate"
      @click="executeScriptAction(action)"
    >
      <component :is="resolveScriptActionIcon(action.icon)" :size="15" />
      <span>{{ action.name }}</span>
      <RefreshCw v-if="runningScriptActionId === action.id" :size="13" class="is-spinning" />
    </button>
    <button v-if="payload.canConfigure" type="button" class="script-action-add" @click="openScriptActionManager()"><Plus :size="14" />{{ selectedService.scriptActions.length ? $t('配置按钮') : $t('添加功能按钮') }}</button>
  </div>

  <div v-if="selectedLogs.length" class="service-log-ribbon">
    <FileText :size="15" /><span>{{ $t('关联日志') }}</span>
    <button v-for="log in selectedLogs" :key="log.id" type="button" @click="emit('open-log', log.id)">{{ log.name }}<small>{{ log.connectionName }}</small></button>
  </div>
</template>
