<script setup lang="ts">
import { Activity, CircleAlert } from "@lucide/vue";
import { computed } from "vue";

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
  health: string;
}

export interface MonitoringProblemNode {
  serviceId: string;
  serviceName: string;
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
  color: "#397ea8",
  values: props.points.map((point) => point.cpuUsedPercent),
}]);

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}
</script>

<template>
  <section class="service-apm">
    <div class="service-apm__columns">
      <article>
        <h3>{{ $t('资源排行') }}</h3>
        <button v-for="service in ranking" :key="service.id" type="button" :class="{ 'is-active': selected?.id === service.id }" @click="emit('select', service)">
          <strong>{{ service.name }}</strong>
          <small>{{ service.environmentName }} · {{ formatPercent(service.cpuUsedPercent) }}</small>
        </button>
        <p v-if="!ranking.length" class="is-empty">{{ $t('暂无服务时序') }}</p>
      </article>
      <article>
        <h3>{{ $t('高负载节点') }}</h3>
        <button v-for="node in problemNodes" :key="String(node.id)" type="button" @click="emit('inspect', node)">
          <strong>{{ node.serviceName }} / {{ String(node.name ?? "") }}</strong>
          <small>{{ String(node.sshConnectionName ?? "") }} · CPU {{ formatPercent(typeof node.cpuUsedPercent === "number" ? node.cpuUsedPercent : null) }}</small>
        </button>
        <p v-if="!problemNodes.length" class="is-empty">{{ $t('暂无服务时序') }}</p>
      </article>
    </div>
    <div class="service-apm__matrix">
      <h3>{{ $t('服务健康矩阵') }}</h3>
      <div>
        <button v-for="service in services" :key="service.id" type="button" class="health-chip" :class="`is-${service.health}`" @click="emit('select', service)">
          {{ service.name }}
          <small>{{ service.runningCount }}/{{ service.deploymentCount }}</small>
        </button>
      </div>
    </div>
    <MonitorTimeSeriesChart
      v-if="selected && points.length"
      :title="selected.name"
      :subtitle="loadingTimeseries ? $t('正在读取监控历史') : selected.environmentName"
      :icon="Activity"
      :points="points"
      :series="cpuSeries"
      format="percent"
    />
    <div v-else class="service-apm__empty"><CircleAlert :size="18" />{{ $t('暂无服务时序') }}</div>
  </section>
</template>

<style scoped>
.service-apm { display: grid; gap: 1rem; }
.service-apm__columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.service-apm article, .service-apm__matrix { padding: 1rem; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); }
.service-apm h3 { margin: 0 0 .75rem; font-size: .8125rem; }
.service-apm button { width: 100%; margin: 0 0 .5rem; padding: .625rem .75rem; border: 1px solid var(--ink-100); border-radius: 8px; display: grid; gap: .25rem; background: transparent; text-align: start; cursor: pointer; }
.service-apm button.is-active { border-color: var(--teal-500); }
.service-apm strong { font-size: .8125rem; }
.service-apm small, .is-empty { color: var(--ink-400); font-size: .6875rem; }
.health-chip { width: auto !important; display: inline-flex !important; align-items: center; gap: .375rem; margin: 0 .5rem .5rem 0 !important; }
.health-chip.is-running { color: var(--color-accent-strong); }
.health-chip.is-degraded { color: var(--color-warning); }
.health-chip.is-disabled, .health-chip.is-unknown, .health-chip.is-empty { color: var(--ink-400); }
.service-apm__empty { min-height: 8rem; display: flex; align-items: center; justify-content: center; gap: .5rem; color: var(--ink-400); }
@media (max-width: 899px) { .service-apm__columns { grid-template-columns: minmax(0, 1fr); } }
</style>
