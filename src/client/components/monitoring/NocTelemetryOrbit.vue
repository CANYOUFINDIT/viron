<script setup lang="ts">
import { computed, ref } from "vue";
import type { MonitoringHostPriorityState } from "../../../shared/monitoring";
import type { MonitoringHostCard } from "./HostFleetPanel.vue";

const props = defineProps<{
  hosts: { host: MonitoringHostCard; state: MonitoringHostPriorityState; pressure: number }[];
  total: number;
}>();

const selectedId = ref("");
const selected = computed(() => props.hosts.find(({ host }) => host.sshConnectionId === selectedId.value) ?? props.hosts[0]);
const nodes = computed(() => props.hosts.map((item, index) => {
  const angle = (index / Math.max(props.hosts.length, 1)) * Math.PI * 2 - Math.PI / 2;
  const radius = index % 2 ? 132 : 153;
  return { ...item, x: 200 + Math.cos(angle) * radius, y: 200 + Math.sin(angle) * radius };
}));
const selectedNode = computed(() => nodes.value.find(({ host }) => host.sshConnectionId === selected.value?.host.sshConnectionId));
const priorityHosts = computed(() => props.hosts.slice(0, 6));
const stateLabels: Record<MonitoringHostPriorityState, string> = {
  healthy: "正常", warning: "关注", critical: "高危", offline: "离线", unmanaged: "未纳管",
};
const probeLabels = { online: "采集在线", stale: "数据陈旧", offline: "探针离线", unreachable: "连接异常", missing: "未装探针", unchecked: "尚未检测" };

function percent(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${Math.round(value)}%`;
}
</script>

<template>
  <div class="noc-orbit" :class="{ 'is-empty': !hosts.length }">
    <div class="noc-orbit__caption"><span>主机采集态势</span><span>{{ hosts.length }} / {{ total }} NODES</span></div>
    <div class="noc-orbit__stage">
      <div class="noc-orbit__radar">
        <div class="noc-orbit__sweep" aria-hidden="true"></div>
        <svg class="noc-orbit__geometry" viewBox="0 0 400 400" aria-hidden="true">
          <g class="noc-orbit__grid">
            <path d="M200 6V394M6 200H394M63 63L337 337M63 337L337 63" />
            <circle cx="200" cy="200" r="182" />
            <circle cx="200" cy="200" r="153" />
            <circle cx="200" cy="200" r="132" />
            <circle cx="200" cy="200" r="106" />
          </g>
          <circle class="noc-orbit__ticks" cx="200" cy="200" r="174" />
          <g class="noc-orbit__rotation">
            <circle class="noc-orbit__arc" cx="200" cy="200" r="185" />
          </g>
          <g class="noc-orbit__rotation noc-orbit__rotation--reverse">
            <circle class="noc-orbit__arc noc-orbit__arc--inner" cx="200" cy="200" r="100" />
          </g>
          <path v-if="selectedNode" class="noc-orbit__signal" :class="`is-${selectedNode.state}`" :d="`M200 200 L${selectedNode.x} ${selectedNode.y}`" />
        </svg>
        <div class="noc-orbit__core">
          <span>TELEMETRY</span>
          <strong>{{ total.toString().padStart(2, '0') }}</strong>
          <small>{{ hosts.length ? '有效指标主机' : '等待有效采样' }}</small>
          <i aria-hidden="true"></i>
        </div>
        <button
          v-for="node in nodes" :key="node.host.sshConnectionId"
          type="button" class="noc-orbit__node" :class="[`is-${node.state}`, { 'is-selected': selected?.host.sshConnectionId === node.host.sshConnectionId }]"
          :style="{ left: `${node.x / 4}%`, top: `${node.y / 4}%` }"
          :aria-label="`${node.host.connectionName} · ${stateLabels[node.state]} · CPU ${percent(node.host.cpuUsedPercent)}`"
          :aria-pressed="selected?.host.sshConnectionId === node.host.sshConnectionId"
          :title="`${node.host.connectionName} · ${stateLabels[node.state]}`"
          @click="selectedId = node.host.sshConnectionId"
        ><i></i></button>
        <span class="noc-orbit__bearing noc-orbit__bearing--top">000</span>
        <span class="noc-orbit__bearing noc-orbit__bearing--bottom">180</span>
      </div>
      <div class="noc-orbit__priority" aria-label="重点主机">
        <button
          v-for="(item, index) in priorityHosts" :key="item.host.sshConnectionId" type="button"
          class="noc-orbit__host" :class="[`is-${item.state}`, { 'is-selected': selected?.host.sshConnectionId === item.host.sshConnectionId }]"
          :aria-pressed="selected?.host.sshConnectionId === item.host.sshConnectionId"
          @click="selectedId = item.host.sshConnectionId"
        >
          <span class="noc-orbit__host-index">0{{ index + 1 }} <i></i></span>
          <strong>{{ item.host.connectionName }}</strong>
          <small>{{ stateLabels[item.state] }} <span>CPU {{ percent(item.host.cpuUsedPercent) }}</span></small>
        </button>
      </div>
    </div>
    <div v-if="selected" class="noc-orbit__inspector" :class="`is-${selected.state}`">
      <div class="noc-orbit__selected-name"><small>SELECTED NODE / {{ probeLabels[selected.host.probeState] }}</small><strong>{{ selected.host.connectionName }}</strong><span>{{ selected.host.host }}</span></div>
      <div v-for="metric in [ { label: 'CPU', value: selected.host.cpuUsedPercent }, { label: 'MEM', value: selected.host.memoryUsedPercent }, { label: 'DSK', value: selected.host.diskUsedPercent } ]" :key="metric.label" class="noc-orbit__metric">
        <small>{{ metric.label }}</small><strong>{{ percent(metric.value) }}</strong><i><b :style="{ width: `${Math.max(0, Math.min(100, metric.value ?? 0))}%` }"></b></i>
      </div>
    </div>
    <div v-else class="noc-orbit__empty">暂无有效主机指标，等待探针采集</div>
    <div class="noc-orbit__legend"><span><i></i>正常</span><span><i></i>关注</span><span><i></i>高危 / 离线</span><small>节点代表主机最新采样 · 点击查看指标</small></div>
  </div>
</template>

<style scoped>
.noc-orbit { min-height: 0; position: relative; display: flex; flex-direction: column; flex: 1; padding: calc(12 * var(--noc-unit)); overflow: hidden; background: radial-gradient(ellipse at 50% 42%, #10494f38, transparent 64%); }
.noc-orbit__caption { display: flex; justify-content: space-between; color: #7cacae; font: calc(8 * var(--noc-unit)) var(--font-mono); letter-spacing: .15em; }
.noc-orbit__caption span:first-child { color: var(--noc-cyan); }
.noc-orbit__stage { position: relative; min-height: 0; flex: 1; display: grid; place-items: center; container-type: size; }
.noc-orbit__radar { position: absolute; width: min(100cqh, 73cqw, calc(380 * var(--noc-unit))); aspect-ratio: 1; }
.noc-orbit__geometry { display: block; position: relative; width: 100%; height: 100%; overflow: visible; }
.noc-orbit__grid { fill: none; stroke: #2f839044; stroke-width: .65; }
.noc-orbit__ticks { fill: none; stroke: #599eaa66; stroke-width: 5; stroke-dasharray: 1 8.1; }
.noc-orbit__arc { fill: none; stroke: var(--noc-cyan); stroke-width: 1.5; stroke-dasharray: 120 460; filter: drop-shadow(0 0 4px #5cc8e8); }
.noc-orbit__arc--inner { stroke: var(--noc-mint); stroke-width: 2; stroke-dasharray: 64 250; }
.noc-orbit__rotation { transform-origin: 200px 200px; animation: orbit-turn 48s linear infinite; }
.noc-orbit__rotation--reverse { animation-duration: 28s; animation-direction: reverse; }
.noc-orbit__sweep { position: absolute; inset: 12%; border-radius: 50%; background: conic-gradient(from 0deg, transparent 65%, #53e3b306 78%, #53e3b327 99.5%, #53e3b35c); animation: orbit-turn 16s linear infinite; mask-image: radial-gradient(circle, transparent 30%, #000 65%); }
.noc-orbit__signal { stroke: var(--node-color, var(--noc-mint)); stroke-width: 1; stroke-dasharray: 3 12; opacity: .65; animation: orbit-signal 3s linear infinite; }
.noc-orbit__core { position: absolute; inset: 28%; border: 1px solid #53e3b34a; border-radius: 50%; background: radial-gradient(circle at 50% 20%, #153137, #071319 75%); box-shadow: inset 0 0 28px #53e3b310, 0 0 24px #53e3b30d; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.noc-orbit__core > span { color: var(--noc-cyan); font: calc(7 * var(--noc-unit)) var(--font-mono); letter-spacing: .2em; }
.noc-orbit__core > strong { margin: calc(4 * var(--noc-unit)) 0; color: #efffff; font: 500 calc(46 * var(--noc-unit))/1 var(--font-mono); letter-spacing: -.06em; text-shadow: 0 0 28px #53e3b365; }
.noc-orbit__core > small { color: #8bb6b7; font-size: calc(8 * var(--noc-unit)); }
.noc-orbit__core > i { margin-top: calc(9 * var(--noc-unit)); width: 26%; height: calc(2 * var(--noc-unit)); background: repeating-linear-gradient(90deg, #53e3b3 0 3px, transparent 3px 6px); box-shadow: 0 0 8px #53e3b366; }
.noc-orbit__bearing { position: absolute; left: 50%; transform: translateX(-50%); color: #527c85; background: #071218; font: calc(6 * var(--noc-unit)) var(--font-mono); letter-spacing: .15em; }
.noc-orbit__bearing--top { top: 1%; }
.noc-orbit__bearing--bottom { bottom: 1%; }
.noc-orbit__node { position: absolute; width: calc(19 * var(--noc-unit)); height: calc(19 * var(--noc-unit)); transform: translate(-50%, -50%); padding: 0; border: 1px solid transparent; border-radius: 50%; background: transparent; color: var(--node-color, var(--noc-mint)); cursor: pointer; display: grid; place-items: center; }
.noc-orbit__node > i { width: calc(5 * var(--noc-unit)); height: calc(5 * var(--noc-unit)); border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
.noc-orbit__node.is-selected { border-color: currentColor; background: #071218; box-shadow: 0 0 12px #53e3b320; }
.noc-orbit__node:focus-visible, .noc-orbit__host:focus-visible { outline: 2px solid var(--noc-cyan); outline-offset: 3px; }
.is-warning { --node-color: var(--noc-amber); }
.is-critical, .is-offline { --node-color: var(--noc-red); }
.is-unmanaged { --node-color: var(--noc-muted); }
.noc-orbit__priority { position: absolute; inset: 11% 0; display: grid; grid-template-columns: 1fr 1fr; align-content: space-around; pointer-events: none; }
.noc-orbit__host { position: relative; width: calc(112 * var(--noc-unit)); min-width: 0; padding: calc(7 * var(--noc-unit)); text-align: left; border: 0; border-left: 1px solid var(--node-color, #53e3b366); background: linear-gradient(90deg, #0b1d25ee, #0b1d2500); color: var(--noc-text); cursor: pointer; pointer-events: auto; }
.noc-orbit__host:nth-child(even) { justify-self: end; }
.noc-orbit__host::after { content: ""; position: absolute; top: 50%; left: 100%; width: calc(15 * var(--noc-unit)); height: 1px; background: var(--node-color, #53e3b366); opacity: .4; }
.noc-orbit__host:nth-child(even)::after { left: auto; right: 100%; }
.noc-orbit__host.is-selected { background: linear-gradient(90deg, #1c495488, #0b1d2500); border-left-width: 2px; }
.noc-orbit__host-index { display: flex; align-items: center; gap: calc(5 * var(--noc-unit)); color: #607f86; font: calc(6 * var(--noc-unit)) var(--font-mono); letter-spacing: .15em; }
.noc-orbit__host-index i { width: calc(3 * var(--noc-unit)); height: calc(3 * var(--noc-unit)); background: var(--node-color, var(--noc-mint)); }
.noc-orbit__host > strong { display: block; margin: calc(3 * var(--noc-unit)) 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(9 * var(--noc-unit)); font-weight: 600; }
.noc-orbit__host > small { display: flex; justify-content: space-between; color: var(--node-color, var(--noc-mint)); font-size: calc(7 * var(--noc-unit)); }
.noc-orbit__host > small span { color: #8caeaf; font-family: var(--font-mono); }
.noc-orbit__inspector { flex: none; display: grid; grid-template-columns: minmax(0, 1.7fr) repeat(3, minmax(0, .7fr)); gap: calc(15 * var(--noc-unit)); padding: calc(12 * var(--noc-unit)); border: 1px solid #25434b; border-left: 2px solid var(--node-color, var(--noc-mint)); background: linear-gradient(110deg, #102a3299, #0a151d99); }
.noc-orbit__selected-name { display: flex; flex-direction: column; gap: calc(4 * var(--noc-unit)); min-width: 0; }
.noc-orbit__selected-name > small, .noc-orbit__metric small { color: #6e989e; font: calc(6 * var(--noc-unit)) var(--font-mono); letter-spacing: .08em; }
.noc-orbit__selected-name > strong { color: #d4edeb; font-size: calc(10 * var(--noc-unit)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.noc-orbit__selected-name > span { color: #6e989e; font: calc(7 * var(--noc-unit)) var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.noc-orbit__metric { display: flex; flex-direction: column; justify-content: center; gap: calc(4 * var(--noc-unit)); }
.noc-orbit__metric strong { font: calc(17 * var(--noc-unit)) var(--font-mono); color: #d6ecec; }
.noc-orbit__metric > i { height: calc(2 * var(--noc-unit)); background: #20343c; }
.noc-orbit__metric b { display: block; height: 100%; background: var(--noc-cyan); transition: width .8s ease; }
.noc-orbit__metric:nth-child(3) b { background: var(--noc-mint); }
.noc-orbit__metric:nth-child(4) b { background: var(--noc-amber); }
.noc-orbit__legend { flex: none; display: flex; align-items: center; gap: calc(12 * var(--noc-unit)); margin-top: calc(10 * var(--noc-unit)); color: #80a1a5; font-size: calc(7 * var(--noc-unit)); }
.noc-orbit__legend > span { display: flex; align-items: center; gap: calc(4 * var(--noc-unit)); white-space: nowrap; }
.noc-orbit__legend i { width: calc(4 * var(--noc-unit)); height: calc(4 * var(--noc-unit)); border-radius: 50%; background: var(--noc-mint); }
.noc-orbit__legend > span:nth-child(2) i { background: var(--noc-amber); }
.noc-orbit__legend > span:nth-child(3) i { background: var(--noc-red); }
.noc-orbit__legend small { margin-left: auto; color: #5f848a; font-size: inherit; }
.noc-orbit__empty { padding: calc(14 * var(--noc-unit)); color: #80a1a5; font-size: calc(9 * var(--noc-unit)); text-align: center; }
.is-empty .noc-orbit__sweep { opacity: .3; }
.is-empty .noc-orbit__core > strong { color: #6d9198; text-shadow: none; }
@keyframes orbit-turn { to { transform: rotate(360deg); } }
@keyframes orbit-signal { to { stroke-dashoffset: -60; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
@media (max-width: 600px) { .noc-orbit__legend small { display: none; } .noc-orbit__host { width: calc(90 * var(--noc-unit)); } }
</style>
