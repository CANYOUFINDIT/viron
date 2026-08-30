<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Flame,
  Layers,
  Sparkles,
  TrendingUp,
} from "@lucide/vue";
import { computed } from "vue";
import { translate as tr } from "../../i18n";
import MonitorTimeSeriesChart from "../MonitorTimeSeriesChart.vue";

export interface MonitoringServiceCard {
  id: string;
  name: string;
  status: string;
  environmentId: string;
  environmentName: string;
  deploymentCount: number;
  runningCount: number;
  problemCount: number;
  cpuUsedPercent: number | null;
  memoryBytes: number | null;
  restartCount?: number;
  activeAlertCount?: number;
  activeAlertPeakSeverity?: "info" | "warning" | "major" | "critical" | null;
  health: string;
}

export interface MonitoringProblemNode {
  serviceId: string;
  serviceName: string;
  environmentId: string;
  id: string;
  name: unknown;
  status: unknown;
  sshConnectionName: unknown;
  cpuUsedPercent: unknown;
  restartCount: unknown;
}

const props = defineProps<{
  services: MonitoringServiceCard[];
  ranking: MonitoringServiceCard[];
  problemNodes: MonitoringProblemNode[];
  selectedServiceId: string;
  points: Array<{ at: string; breakBefore?: boolean; cpuUsedPercent: number | null; memoryBytes: number | null }>;
  loadingTimeseries: boolean;
}>();

const emit = defineEmits<{ select: [service: MonitoringServiceCard]; inspect: [node: MonitoringProblemNode] }>();

const selected = computed(() => props.services.find((item) => item.id === props.selectedServiceId) ?? null);
const cpuSeries = computed(() => [{
  key: "cpu",
  label: "CPU",
  color: "#219780",
  values: props.points.map((point) => point.cpuUsedPercent),
}]);
const memorySeries = computed(() => [{
  key: "memory",
  label: "MEM",
  color: "#8b5cf6",
  values: props.points.map((point) => point.memoryBytes),
}]);

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatBytes(value: number | null) {
  if (value === null) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024).toFixed(0)} KB`;
}
</script>

<template>
  <section class="service-apm">
    <div class="service-apm__columns">
      <!-- 资源占用排行 -->
      <article class="apm-panel-card">
        <header class="apm-panel-header">
          <div class="apm-panel-title">
            <Flame :size="16" class="text-amber" />
            <h3>{{ $t('服务资源占用排行') }}</h3>
          </div>
          <small class="text-muted">{{ ranking.length }} {{ $t('个服务') }}</small>
        </header>

        <div v-if="ranking.length" class="ranking-items-list">
          <button
            v-for="(service, idx) in ranking"
            :key="service.id"
            type="button"
            class="ranking-item"
            :class="{ 'is-active': selected?.id === service.id }"
            @click="emit('select', service)"
          >
            <span class="rank-index" :class="`is-top-${idx + 1}`">{{ idx + 1 }}</span>
            <div class="rank-info">
              <strong>{{ service.name }}</strong>
              <small>{{ service.environmentName }}</small>
            </div>
            <div class="rank-metrics">
              <span class="rank-cpu">CPU {{ formatPercent(service.cpuUsedPercent) }}</span>
              <span class="rank-mem">MEM {{ formatBytes(service.memoryBytes) }}</span>
            </div>
          </button>
        </div>
        <div v-else class="apm-empty-state"><CircleAlert :size="20" /><span>{{ $t('暂无服务时序') }}</span></div>
      </article>

      <!-- 高负载与异常节点 -->
      <article class="apm-panel-card">
        <header class="apm-panel-header">
          <div class="apm-panel-title">
            <AlertTriangle :size="16" class="text-danger" />
            <h3>{{ $t('高负载与异常节点') }}</h3>
          </div>
          <small class="text-muted">{{ problemNodes.length }} {{ $t('个节点') }}</small>
        </header>

        <div v-if="problemNodes.length" class="problem-nodes-list">
          <div v-for="node in problemNodes" :key="String(node.id)" class="problem-node-card">
            <div class="problem-node-top">
              <div class="node-name-group">
                <strong>{{ node.serviceName }}</strong>
                <span>/</span>
                <span class="node-inst-name">{{ String(node.name ?? "") }}</span>
              </div>
              <span class="node-host-tag">{{ String(node.sshConnectionName ?? "") }}</span>
            </div>
            <div class="problem-node-bottom">
              <div class="node-stats">
                <span class="stat-cpu">CPU {{ formatPercent(typeof node.cpuUsedPercent === "number" ? node.cpuUsedPercent : null) }}</span>
                <span v-if="Number(node.restartCount ?? 0) > 0" class="stat-restart">
                  {{ $t('重启') }} {{ Number(node.restartCount) }}
                </span>
              </div>
              <button type="button" class="inspect-btn" @click="emit('inspect', node)">
                {{ $t('立即排查') }} →
              </button>
            </div>
          </div>
        </div>
        <div v-else class="apm-empty-state is-success">
          <CheckCircle2 :size="20" class="text-healthy" />
          <span>{{ $t('当前未发现高负载异常节点') }}</span>
        </div>
      </article>
    </div>

    <!-- 服务健康拓扑矩阵 -->
    <div class="service-apm__matrix-card">
      <header class="apm-panel-header">
        <div class="apm-panel-title">
          <Boxes :size="16" class="text-teal" />
          <h3>{{ $t('服务健康拓扑矩阵') }}</h3>
        </div>
        <small class="text-muted">{{ services.length }} {{ $t('个服务实例') }}</small>
      </header>

      <div v-if="services.length" class="health-chips-grid">
        <button
          v-for="service in services"
          :key="service.id"
          type="button"
          class="service-chip"
          :class="[`is-${service.health}`, { 'is-active': selected?.id === service.id }]"
          @click="emit('select', service)"
        >
          <div class="chip-status-dot"></div>
          <strong class="chip-name">{{ service.name }}</strong>
          <span class="chip-count">{{ service.runningCount }}/{{ service.deploymentCount }}</span>
        </button>
      </div>
      <div v-else class="apm-empty-state"><CircleAlert :size="20" /><span>{{ $t('暂无服务实例') }}</span></div>
    </div>

    <!-- 选中服务的时序图表 -->
    <div v-if="selected && points.length" class="service-charts-stage">
      <MonitorTimeSeriesChart
        :title="selected.name"
        :subtitle="loadingTimeseries ? $t('正在读取监控历史') : `${selected.environmentName} · CPU 利用率`"
        :icon="Activity"
        :points="points"
        :series="cpuSeries"
        format="percent"
      />
      <MonitorTimeSeriesChart
        :title="$t('{{0}} · 内存消耗', [selected.name])"
        :subtitle="loadingTimeseries ? $t('正在读取监控历史') : `${selected.environmentName} · 内存占用`"
        :icon="Activity"
        :points="points"
        :series="memorySeries"
        format="bytes"
      />
    </div>
    <div v-else-if="selected" class="service-apm__empty-chart">
      <Activity :size="22" />
      <span>{{ $t('正在读取该服务的实时监控时序...') }}</span>
    </div>
  </section>
</template>

<style scoped>
.service-apm {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.service-apm__columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.apm-panel-card,
.service-apm__matrix-card {
  padding: 16px;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.apm-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.apm-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.apm-panel-title h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 750;
  color: var(--ink-900);
}

.text-muted { color: var(--ink-400); font-size: 11px; }
.text-amber { color: #d97706; }
.text-danger { color: #dc2626; }
.text-teal { color: var(--teal-600); }
.text-healthy { color: #10b981; }

/* 资源排行列表 */
.ranking-items-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ranking-item {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: var(--ink-50);
  color: inherit;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  text-align: left;
  transition: all .15s ease;
}

.ranking-item:hover {
  border-color: var(--teal-300);
  background: var(--surface);
}

.ranking-item.is-active {
  border-color: var(--teal-500);
  background: var(--teal-50);
}

.rank-index {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--ink-200);
  color: var(--ink-700);
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 800;
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.rank-index.is-top-1 { background: #fee2e2; color: #dc2626; }
.rank-index.is-top-2 { background: #fef3c7; color: #d97706; }
.rank-index.is-top-3 { background: #e0e7ff; color: #4338ca; }

.rank-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rank-info strong {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-900);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-info small {
  font-size: 10px;
  color: var(--ink-400);
}

.rank-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 650;
  flex-shrink: 0;
}

.rank-cpu { color: #d97706; }
.rank-mem { color: #8b5cf6; }

/* 问题节点卡片 */
.problem-nodes-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.problem-node-card {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--red-100) 70%, var(--ink-100));
  border-radius: 8px;
  background: color-mix(in srgb, var(--red-100) 15%, var(--surface));
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.problem-node-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.node-name-group {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.node-name-group strong {
  color: var(--ink-900);
}

.node-inst-name {
  color: var(--ink-600);
}

.node-host-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ink-100);
  color: var(--ink-500);
  font-family: var(--font-mono);
}

.problem-node-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.node-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.stat-cpu { color: #dc2626; font-weight: 700; }
.stat-restart { color: #d97706; font-weight: 700; }

.inspect-btn {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--teal-700);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.inspect-btn:hover {
  text-decoration: underline;
}

/* 服务健康矩阵 */
.health-chips-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.service-chip {
  padding: 6px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: var(--surface);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: all .16s ease;
}

.service-chip:hover {
  border-color: var(--teal-300);
}

.service-chip.is-active {
  border-color: var(--teal-500);
  background: var(--teal-50);
}

.chip-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
}

.service-chip.is-degraded .chip-status-dot { background: #f59e0b; }
.service-chip.is-disabled .chip-status-dot,
.service-chip.is-unknown .chip-status-dot { background: var(--ink-300); }

.chip-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-900);
}

.chip-count {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ink-50);
  color: var(--ink-500);
}

.service-charts-stage {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.apm-empty-state,
.service-apm__empty-chart {
  min-height: 80px;
  padding: 20px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-400);
  font-size: 12px;
}

.apm-empty-state.is-success {
  color: var(--ink-600);
}

@media (max-width: 899px) {
  .service-apm__columns,
  .service-charts-stage {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
