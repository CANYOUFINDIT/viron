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
const networkRanking = computed(() => props.hosts
  .map((host) => ({ host, total: Number(host.networkReceiveBytesPerSecond ?? 0) + Number(host.networkTransmitBytesPerSecond ?? 0) }))
  .sort((left, right) => right.total - left.total)
  .slice(0, 8));
const storageWarnings = computed(() => props.hosts
  .filter((host) => host.worstDisk?.usedPercent != null)
  .sort((left, right) => Number(right.worstDisk?.usedPercent ?? 0) - Number(left.worstDisk?.usedPercent ?? 0))
  .slice(0, 8));
const distributionStyle = computed(() => {
  const total = Math.max(1, props.summary.hostTotal);
  const online = props.summary.hostOnline / total * 360;
  const offline = props.summary.hostOffline / total * 360;
  const missing = props.summary.hostMissing / total * 360;
  return { background: `conic-gradient(#00f2c3 0deg ${online}deg, #ff5c62 ${online}deg ${online + offline}deg, #87939c ${online + offline}deg ${online + offline + missing}deg, #ffb300 ${online + offline + missing}deg 360deg)` };
});

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(0)}%`;
}

function formatRate(value: number) {
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

function heatClass(host: MonitoringHostCard) {
  if (host.offline || host.missing) return "is-down";
  if (host.stale) return "is-unknown";
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
  <Teleport to="body">
  <section ref="root" class="noc-screen" :class="{ 'is-reduced': reducedMotion }" role="dialog" aria-label="NOC">
    <header>
      <strong>VIRON CLUSTER OPERATIONS CENTER</strong>
      <span class="noc-live" aria-live="polite">LIVE · {{ generatedAt ? new Date(generatedAt).toLocaleTimeString() : "—" }}</span>
      <button type="button" :aria-label="$t('退出全屏')" @click="emit('exit')"><Minimize :size="16" />{{ $t('退出全屏') }}</button>
    </header>
    <div class="noc-grid">
      <aside>
        <h3>{{ $t('节点运行状态') }}</h3>
        <div class="noc-donut" :style="distributionStyle"><span><strong>{{ summary.hostOnline }}</strong><small>/ {{ summary.hostTotal }} ONLINE</small></span></div>
        <p class="noc-legend">🟢 {{ summary.hostOnline }} · 🔴 {{ summary.hostOffline }} · ⚪ {{ summary.hostMissing }} · ⚠ {{ summary.hostStale }}</p>
        <h3>{{ $t('实时告警流') }}</h3>
        <ol v-if="alerts.length" class="noc-alert-stream">
          <li v-for="alert in alerts.slice(0, 12)" :key="alert.id">{{ alert.targetName }} · {{ alert.status }}</li>
        </ol>
        <p v-else class="noc-empty">{{ $t('暂无活动告警') }}</p>
      </aside>
      <main>
        <div class="noc-gauges">
          <article><small>CPU</small><strong>{{ formatPercent(summary.avgCpuPercent) }}</strong></article>
          <article><small>MEM</small><strong>{{ formatPercent(summary.avgMemoryPercent) }}</strong></article>
          <article><small>DISK</small><strong>{{ summary.diskAlerts }}</strong></article>
        </div>
        <div class="noc-wave" aria-label="CPU waveform">
          <i v-for="host in heatHosts.slice(0, 28)" :key="`wave-${host.sshConnectionId}`" :style="{ height: `${Math.max(8, host.cpuUsedPercent || 0)}%` }"></i>
        </div>
        <div v-if="heatHosts.length" class="noc-heat">
          <button v-for="host in heatHosts" :key="host.sshConnectionId" type="button" :class="heatClass(host)" :title="host.connectionName">
            {{ formatPercent(host.cpuUsedPercent) }}
          </button>
        </div>
        <p v-else class="noc-empty">{{ $t('暂无主机矩阵') }}</p>
      </main>
      <aside>
        <h3>{{ $t('网络吞吐排行') }}</h3>
        <ol v-if="networkRanking.length">
          <li v-for="item in networkRanking" :key="item.host.sshConnectionId"><span>{{ item.host.connectionName }}</span><strong>{{ formatRate(item.total) }}</strong></li>
        </ol>
        <p v-else class="noc-empty">{{ $t('暂无网络数据') }}</p>
        <h3>{{ $t('存储容量水位') }}</h3>
        <ol v-if="storageWarnings.length">
          <li v-for="host in storageWarnings" :key="`disk-${host.sshConnectionId}`"><span>{{ host.connectionName }} · {{ host.worstDisk?.path }}</span><strong>{{ formatPercent(host.worstDisk?.usedPercent ?? null) }}</strong></li>
        </ol>
        <p v-else class="noc-empty">{{ $t('暂无存储数据') }}</p>
      </aside>
    </div>
  </section>
  </Teleport>
</template>

<style scoped>
.noc-screen {
  position: fixed; inset: 0; z-index: 90; display: grid; grid-template-rows: auto minmax(0, 1fr);
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
.noc-grid h3 { margin: 0 0 .75rem; color: #86a9a5; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
.noc-donut { width: 9rem; aspect-ratio: 1; margin: 1rem auto; border-radius: 50%; display: grid; place-items: center; }
.noc-donut::before { content: ""; grid-area: 1 / 1; width: 68%; aspect-ratio: 1; border-radius: 50%; background: #101820; }
.noc-donut span { z-index: 1; grid-area: 1 / 1; display: grid; justify-items: center; }
.noc-donut strong { color: #00f2c3; font-size: 2rem; }
.noc-donut small { color: #86a9a5; font-size: .55rem; letter-spacing: .08em; }
.noc-legend { text-align: center; color: #86a9a5; font-size: .7rem; }
.noc-alert-stream { max-height: 15rem; overflow: hidden; }
.noc-alert-stream li { animation: noc-alert-rise 18s linear infinite; }
.noc-gauges { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin-bottom: 1rem; }
.noc-gauges article { padding: 1rem; border: 1px solid #16313a; border-radius: 10px; }
.noc-gauges strong { display: block; font-size: 1.75rem; color: #00f2c3; }
.noc-wave { height: 7rem; margin-bottom: 1rem; padding: .5rem; border: 1px solid #16313a; display: flex; align-items: flex-end; gap: 3px; overflow: hidden; background: linear-gradient(to bottom, transparent 24%, #16313a 25%, transparent 26%, transparent 49%, #16313a 50%, transparent 51%, transparent 74%, #16313a 75%, transparent 76%); }
.noc-wave i { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; background: #00f2c3; box-shadow: 0 0 8px rgba(0, 242, 195, .34); transition: height .5s ease; }
.noc-heat { display: grid; grid-template-columns: repeat(auto-fill, minmax(3.5rem, 1fr)); gap: .375rem; }
.noc-heat button { min-height: 2.75rem; border: 0; border-radius: 6px; color: #0b1118; font-family: var(--font-mono); cursor: default; }
.noc-heat .is-ok { background: #00f2c3; }
.noc-heat .is-warn { background: #ffb300; }
.noc-grid aside ol { margin: 0 0 1.25rem; padding: 0; display: grid; gap: .4rem; list-style: none; }
.noc-grid aside li { padding: .45rem .55rem; border-left: 2px solid #1e4d4a; display: flex; justify-content: space-between; gap: .75rem; background: #0b1118; color: #a8c2be; font-size: .68rem; }
.noc-grid aside li strong { color: #d7f7ee; font-family: var(--font-mono); }
@keyframes noc-alert-rise { from { transform: translateY(0); } to { transform: translateY(-18px); } }
.noc-heat .is-critical { background: #ff4d4f; color: #fff; }
.noc-heat .is-down, .noc-heat .is-unknown { background: #2a3640; color: #8aa; }
.noc-screen ol { margin: 0; padding-left: 1.1rem; display: grid; gap: .375rem; font-size: .75rem; }
.noc-empty { margin: .75rem 0; color: #6f8890; font-size: .75rem; }
.noc-screen.is-reduced .noc-live { animation: none; }
@media (max-width: 899px) { .noc-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
