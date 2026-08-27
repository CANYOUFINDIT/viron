<script setup lang="ts">
import { Minimize } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { MonitoringHostCard } from "./HostFleetPanel.vue";
import type { MonitoringProblemNode, MonitoringServiceCard } from "./ServiceApmPanel.vue";

const props = defineProps<{
  generatedAt: string;
  summary: {
    hostTotal: number;
    hostOnline: number;
    hostOffline: number;
    hostMissing: number;
    hostStale: number;
    avgCpuPercent: number | null;
    avgMemoryPercent: number | null;
    diskAlerts: number;
  };
  hosts: MonitoringHostCard[];
  problemNodes: MonitoringProblemNode[];
  ranking: MonitoringServiceCard[];
  alerts: Array<{ id: string; status: string; targetName: string; environmentName?: string; triggeredAt?: string }>;
}>();
const emit = defineEmits<{ exit: [] }>();
const root = ref<HTMLElement | null>(null);
const reducedMotion = ref(false);

const heatHosts = computed(() => props.hosts.slice(0, 40));

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(0)}%`;
}

function heatClass(host: MonitoringHostCard) {
  if (host.offline || host.missing) return "is-down";
  const cpu = host.cpuUsedPercent;
  if (cpu === null) return "is-unknown";
  if (cpu >= 90) return "is-critical";
  if (cpu >= 80) return "is-warn";
  return "is-ok";
}

async function enterFullscreen() {
  if (!root.value || document.fullscreenElement) return;
  try { await root.value.requestFullscreen(); } catch { /* keep windowed NOC */ }
}

function onFullscreenChange() {
  if (!document.fullscreenElement) emit("exit");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("exit");
}

onMounted(() => {
  reducedMotion.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", onKeydown);
  void enterFullscreen();
});
onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("keydown", onKeydown);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
});
</script>

<template>
  <section ref="root" class="noc-screen" :class="{ 'is-reduced': reducedMotion }" role="dialog" aria-label="NOC">
    <header>
      <strong>VIRON CLUSTER OPERATIONS CENTER</strong>
      <span class="noc-live" aria-live="polite">LIVE · {{ generatedAt ? new Date(generatedAt).toLocaleTimeString() : "—" }}</span>
      <button type="button" :aria-label="$t('退出全屏')" @click="emit('exit')"><Minimize :size="16" />{{ $t('退出全屏') }}</button>
    </header>
    <div class="noc-grid">
      <aside>
        <h3>{{ $t('主机基础设施') }}</h3>
        <p>🟢 {{ summary.hostOnline }} · 🔴 {{ summary.hostOffline }} · ⚪ {{ summary.hostMissing }} · ⚠ {{ summary.hostStale }}</p>
        <ol>
          <li v-for="alert in alerts.slice(0, 12)" :key="alert.id">{{ alert.targetName }} · {{ alert.status }}</li>
        </ol>
      </aside>
      <main>
        <div class="noc-gauges">
          <article><small>CPU</small><strong>{{ formatPercent(summary.avgCpuPercent) }}</strong></article>
          <article><small>MEM</small><strong>{{ formatPercent(summary.avgMemoryPercent) }}</strong></article>
          <article><small>DISK</small><strong>{{ summary.diskAlerts }}</strong></article>
        </div>
        <div class="noc-heat">
          <button v-for="host in heatHosts" :key="host.sshConnectionId" type="button" :class="heatClass(host)" :title="host.connectionName">
            {{ formatPercent(host.cpuUsedPercent) }}
          </button>
        </div>
      </main>
      <aside>
        <h3>{{ $t('高负载节点') }}</h3>
        <ol>
          <li v-for="node in problemNodes.slice(0, 10)" :key="String(node.id)">{{ node.serviceName }} · {{ String(node.name ?? "") }}</li>
        </ol>
        <h3>{{ $t('资源排行') }}</h3>
        <ol>
          <li v-for="service in ranking.slice(0, 8)" :key="service.id">{{ service.name }} · {{ formatPercent(service.cpuUsedPercent) }}</li>
        </ol>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.noc-screen {
  position: fixed; inset: 0; z-index: 80; display: grid; grid-template-rows: auto minmax(0, 1fr);
  background: #0b1118; color: #d7f7ee; font-family: var(--font-body);
}
.noc-screen header {
  min-height: 3.25rem; padding: 0 1.25rem; display: flex; align-items: center; gap: 1rem;
  border-block-end: 1px solid #16313a;
}
.noc-screen header button {
  margin-inline-start: auto; border: 1px solid #1e4d4a; border-radius: 8px; padding: .375rem .75rem;
  display: inline-flex; gap: .375rem; align-items: center; background: transparent; color: inherit; cursor: pointer;
}
.noc-live { color: #00f2c3; letter-spacing: .08em; }
.noc-grid { min-height: 0; display: grid; grid-template-columns: 18rem minmax(0, 1fr) 18rem; gap: 1rem; padding: 1rem; }
.noc-grid aside, .noc-grid main { min-width: 0; padding: 1rem; border: 1px solid #16313a; border-radius: 12px; background: #101820; overflow: auto; }
.noc-gauges { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin-bottom: 1rem; }
.noc-gauges article { padding: 1rem; border: 1px solid #16313a; border-radius: 10px; }
.noc-gauges strong { display: block; font-size: 1.75rem; color: #00f2c3; }
.noc-heat { display: grid; grid-template-columns: repeat(auto-fill, minmax(3.5rem, 1fr)); gap: .375rem; }
.noc-heat button { min-height: 2.75rem; border: 0; border-radius: 6px; color: #0b1118; font-family: var(--font-mono); cursor: default; }
.noc-heat .is-ok { background: #00f2c3; }
.noc-heat .is-warn { background: #ffb300; }
.noc-heat .is-critical { background: #ff4d4f; color: #fff; }
.noc-heat .is-down, .noc-heat .is-unknown { background: #2a3640; color: #8aa; }
.noc-screen ol { margin: 0; padding-left: 1.1rem; display: grid; gap: .375rem; font-size: .75rem; }
.noc-screen.is-reduced .noc-live { animation: none; }
@media (max-width: 899px) { .noc-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
