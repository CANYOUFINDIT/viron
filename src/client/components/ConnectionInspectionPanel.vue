<script setup lang="ts">import { translate as tr } from "../i18n";

import { Activity, CircleCheck, CircleX, Database, MemoryStick, RefreshCw, Search, TerminalSquare } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import TipIcon from "./TipIcon.vue";

interface ConnectionItem {
  id: string;
  type: "ssh" | "database" | "redis";
  name: string;
  host: string;
  port: number;
  username: string;
  tags?: string[];
  connectionGroupPath: string | null;
  lastInspectionStatus: "available" | "unavailable" | null;
  lastInspectionLatencyMs: number | null;
  lastInspectionMessage: string | null;
  lastInspectedAt: string | null;
}

interface InspectionReport {
  summary: { total: number; available: number; unavailable: number };
  items: Array<{
    type: "ssh" | "database" | "redis";
    id: string;
    name: string;
    host: string;
    port: number;
    status: "available" | "unavailable";
    latencyMs: number;
    message: string;
  }>;
}

const props = withDefaults(defineProps<{ sshEnabled?: boolean; databaseEnabled?: boolean; redisEnabled?: boolean }>(), {
  sshEnabled: true,
  databaseEnabled: true,
  redisEnabled: true,
});

const loading = ref(true);
const running = ref(false);
const keyword = ref("");
const type = ref<"all" | "ssh" | "database" | "redis">("all");
const connections = ref<ConnectionItem[]>([]);
const selected = ref<Set<string>>(new Set());
const report = ref<InspectionReport | null>(null);

const candidates = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return connections.value.filter((item) => {
    if (item.type === "ssh" && !props.sshEnabled) return false;
    if (item.type === "database" && !props.databaseEnabled) return false;
    if (item.type === "redis" && !props.redisEnabled) return false;
    if (type.value !== "all" && item.type !== type.value) return false;
    if (!query) return true;
    return `${item.name} ${item.host} ${item.username} ${item.connectionGroupPath ?? ""} ${(item.tags ?? []).join(" ")}`.toLowerCase().includes(query);
  });
});

function key(item: Pick<ConnectionItem, "type" | "id">) {
  return `${item.type}:${item.id}`;
}

async function load() {
  loading.value = true;
  try {
    const response = await api<{ items: ConnectionItem[] }>("/api/v1/connections?assignment=all&type=all");
    connections.value = response.items;
    selected.value = new Set(response.items.filter((item) => item.type === "ssh" ? props.sshEnabled : item.type === "database" ? props.databaseEnabled : props.redisEnabled).map(key));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载巡检连接失败"));
  } finally {
    loading.value = false;
  }
}

function setItem(item: ConnectionItem, value: boolean) {
  const next = new Set(selected.value);
  if (value) next.add(key(item));
  else next.delete(key(item));
  selected.value = next;
}

function setVisible(value: boolean) {
  const next = new Set(selected.value);
  for (const item of candidates.value) {
    if (value) next.add(key(item));
    else next.delete(key(item));
  }
  selected.value = next;
}

async function run() {
  const items = connections.value
    .filter((item) => selected.value.has(key(item)) && (item.type === "ssh" ? props.sshEnabled : item.type === "database" ? props.databaseEnabled : props.redisEnabled))
    .map((item) => ({ type: item.type, id: item.id }));
  if (!items.length) return ElMessage.warning(tr("请至少选择一个连接进行巡检"));
  running.value = true;
  try {
    report.value = await api<InspectionReport>("/api/v1/connections/inspect", { method: "POST", body: JSON.stringify({ items }) });
    ElMessage.success(tr("巡检完成：可用 {0}，不可用 {1}", [report.value.summary.available, report.value.summary.unavailable]));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("连接巡检失败"));
  } finally {
    running.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="tool-panel inspection-tool-panel" v-loading="loading">
    <header class="tool-panel__heading">
      <div class="heading-with-tip"><h3>{{ $t('连接巡检') }}</h3><TipIcon :content="$t('巡检会执行真实协议连接与凭据认证，并保存每条连接最近一次结果。')" placement="right" /></div>
      <el-button :loading="running" :disabled="!selected.size" type="primary" @click="run"><Activity :size="16" />{{ $t('开始巡检') }} {{ selected.size }}</el-button>
    </header>
    <div class="inspection-filters">
      <el-radio-group v-model="type"><el-radio-button value="all">{{ $t('全部') }}</el-radio-button><el-radio-button value="ssh" :disabled="!sshEnabled">SSH</el-radio-button><el-radio-button value="database" :disabled="!databaseEnabled">{{ $t('数据库') }}</el-radio-button><el-radio-button value="redis" :disabled="!redisEnabled">Redis</el-radio-button></el-radio-group>
      <el-input v-model="keyword" clearable :placeholder="$t('连接名称、主机、用户名、标签或连接组')"><template #prefix><Search :size="14" /></template></el-input>
    </div>
    <div class="inspection-selection-toolbar"><span>{{ $t('已选择') }} <strong>{{ selected.size }}</strong> / {{ connections.length }} {{ $t('个连接') }}</span><div><el-button size="small" @click="setVisible(true)">{{ $t('全选当前筛选') }}</el-button><el-button size="small" @click="setVisible(false)">{{ $t('排除当前筛选') }}</el-button><el-button size="small" @click="load"><RefreshCw :size="14" />{{ $t('刷新') }}</el-button></div></div>
    <div class="inspection-candidate-list">
      <label v-for="item in candidates" :key="key(item)" class="inspection-candidate">
        <el-checkbox :model-value="selected.has(key(item))" @change="setItem(item, Boolean($event))" />
        <span :class="['connection-type-icon', `is-${item.type}`]"><TerminalSquare v-if="item.type === 'ssh'" :size="15" /><MemoryStick v-else-if="item.type === 'redis'" :size="15" /><Database v-else :size="15" /></span>
        <span><strong>{{ item.name }}</strong><small>{{ item.username }}@{{ item.host }}:{{ item.port }}</small></span>
        <em>{{ item.connectionGroupPath || $t('未分组') }}</em>
      </label>
      <div v-if="!candidates.length" class="inspection-empty">{{ $t('当前筛选下没有连接') }}</div>
    </div>
    <template v-if="report">
      <div class="inspection-summary inspection-tool-summary">
        <article><span>{{ $t('本次巡检') }}</span><strong>{{ report.summary.total }}</strong></article>
        <article class="is-available"><span>{{ $t('可用') }}</span><strong>{{ report.summary.available }}</strong></article>
        <article class="is-unavailable"><span>{{ $t('不可用') }}</span><strong>{{ report.summary.unavailable }}</strong></article>
      </div>
      <div class="inspection-report-list">
        <article v-for="item in report.items" :key="key(item)" :class="`is-${item.status}`">
          <span class="inspection-report-icon"><CircleCheck v-if="item.status === 'available'" :size="18" /><CircleX v-else :size="18" /></span>
          <div><strong>{{ item.name }}</strong><small>{{ item.type === 'ssh' ? 'SSH' : item.type === 'redis' ? 'Redis' : $t('数据库') }} · {{ item.host }}:{{ item.port }}</small></div>
          <p>{{ item.message }}</p><time>{{ item.latencyMs }} ms</time>
        </article>
      </div>
    </template>
  </section>
</template>
