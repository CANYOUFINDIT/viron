<script setup lang="ts">
import { Activity, CircleAlert, RefreshCw, Server } from "@lucide/vue";
import { computed } from "vue";
import { translate as tr } from "../../i18n";
import HostMonitorDashboard from "../HostMonitorDashboard.vue";

export interface MonitoringHostCard {
  sshConnectionId: string;
  connectionName: string;
  host: string;
  environmentId: string;
  environmentName: string;
  status: string;
  offline: boolean;
  missing: boolean;
  stale: boolean;
  agentVersion: string;
  lastCollectedAt: string | null;
  lastPulledAt?: string | null;
  cpuUsedPercent: number | null;
  memoryUsedPercent: number | null;
  diskUsedPercent: number | null;
  networkReceiveBytesPerSecond?: number | null;
  networkTransmitBytesPerSecond?: number | null;
  temperatureCelsius: number | null;
  operatingSystem: string;
  architecture: string;
  worstDisk: { path: string; usedPercent: number | null } | null;
}

const props = defineProps<{
  hosts: MonitoringHostCard[];
  selectedHostId: string;
  canOperate: boolean;
}>();
const emit = defineEmits<{
  select: [host: MonitoringHostCard];
  install: [host: MonitoringHostCard];
  "open-maintenance": [host: MonitoringHostCard];
}>();

const selected = computed(() => props.hosts.find((host) => host.sshConnectionId === props.selectedHostId) ?? null);

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatRate(value: number | null | undefined) {
  if (value == null) return "—";
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

function formatCollected(value: string | null | undefined) {
  return value ? new Date(value).toLocaleTimeString() : "—";
}

function presence(host: MonitoringHostCard) {
  if (host.offline) return { key: "offline", label: tr("离线") };
  if (host.missing) return { key: "missing", label: tr("探针缺失") };
  if (host.stale) return { key: "stale", label: tr("陈旧数据") };
  if (host.status === "ready") return { key: "online", label: tr("在线") };
  return { key: "unknown", label: tr("未知") };
}
</script>

<template>
  <section class="host-fleet">
    <div class="host-fleet__grid">
      <button
        v-for="host in hosts"
        :key="host.sshConnectionId"
        type="button"
        class="host-card"
        :class="{ 'is-active': selected?.sshConnectionId === host.sshConnectionId, [`is-${presence(host).key}`]: true }"
        @click="emit('select', host)"
      >
        <header>
          <strong>{{ host.connectionName }}</strong>
          <small :class="`is-${presence(host).key}`">{{ presence(host).label }}</small>
        </header>
        <p>{{ host.host }} · {{ host.environmentName }}</p>
        <dl>
          <div><dt>CPU</dt><dd>{{ formatPercent(host.cpuUsedPercent) }}</dd></div>
          <div><dt>{{ $t('内存') }}</dt><dd>{{ formatPercent(host.memoryUsedPercent) }}</dd></div>
          <div><dt>{{ $t('磁盘') }}</dt><dd>{{ formatPercent(host.diskUsedPercent) }}</dd></div>
          <div><dt>{{ $t('网络接收') }}</dt><dd>{{ formatRate(host.networkReceiveBytesPerSecond) }}</dd></div>
          <div><dt>{{ $t('网络发送') }}</dt><dd>{{ formatRate(host.networkTransmitBytesPerSecond) }}</dd></div>
          <div><dt>{{ $t('温度') }}</dt><dd>{{ host.temperatureCelsius === null ? '—' : `${host.temperatureCelsius.toFixed(1)}°C` }}</dd></div>
        </dl>
        <footer><span>Agent {{ host.agentVersion || '—' }}</span><time>{{ $t('采集') }} {{ formatCollected(host.lastCollectedAt) }}</time></footer>
        <span v-if="host.stale" class="host-card__stale">{{ $t('陈旧数据') }}</span>
      </button>
      <div v-if="!hosts.length" class="host-fleet__empty"><Server :size="22" /><strong>{{ $t('暂无监控主机') }}</strong></div>
    </div>
    <div v-if="selected" class="host-fleet__detail">
      <header>
        <div>
          <h3>{{ selected.connectionName }}</h3>
          <p>{{ presence(selected).label }} · {{ selected.operatingSystem }} {{ selected.architecture }}</p>
        </div>
        <button v-if="canOperate && (selected.missing || selected.offline)" type="button" class="host-fleet__install" @click="emit('install', selected)">
          <RefreshCw :size="14" />{{ $t('前往服务维护安装探针') }}
        </button>
      </header>
      <HostMonitorDashboard
        v-if="!selected.missing"
        :environment-id="selected.environmentId"
        :host-id="selected.sshConnectionId"
        :last-collected-at="selected.lastCollectedAt"
        @open-maintenance="emit('open-maintenance', selected)"
      />
      <div v-else class="host-fleet__missing"><CircleAlert :size="18" /><span>{{ $t('探针缺失') }}</span></div>
    </div>
    <div v-else class="host-fleet__hint"><Activity :size="18" />{{ $t('选择一台主机查看时序与 Findings') }}</div>
  </section>
</template>

<style scoped>
.host-fleet { min-width: 0; display: grid; gap: 1rem; }
.host-fleet__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); gap: .75rem; }
.host-card {
  min-width: 0; padding: .875rem 1rem; border: 1px solid var(--ink-100); border-radius: 10px;
  display: grid; gap: .5rem; background: var(--surface); color: inherit; text-align: start; cursor: pointer;
}
.host-card.is-active { border-color: var(--teal-500); box-shadow: var(--shadow-sm); }
.host-card header { display: flex; justify-content: space-between; gap: .5rem; align-items: center; }
.host-card strong { font-size: .875rem; }
.host-card p, .host-card small { margin: 0; color: var(--ink-400); font-size: .6875rem; }
.host-card small.is-online { color: var(--color-accent-strong); }
.host-card small.is-offline, .host-card small.is-missing { color: var(--color-danger); }
.host-card small.is-stale { color: var(--color-warning); }
.host-card dl { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; }
.host-card dt { color: var(--ink-400); font-size: .625rem; }
.host-card dd { margin: 0; font-family: var(--font-mono); font-size: .8125rem; }
.host-card > footer { padding-top: .5rem; border-top: 1px solid var(--ink-100); display: flex; justify-content: space-between; gap: .5rem; color: var(--ink-400); font-family: var(--font-mono); font-size: .625rem; }
.host-card__stale { color: var(--color-warning); font-size: .6875rem; }
.host-fleet__empty, .host-fleet__hint, .host-fleet__missing {
  min-height: 8rem; display: flex; align-items: center; justify-content: center; gap: .5rem; color: var(--ink-400);
}
.host-fleet__detail { min-width: 0; border: 1px solid var(--ink-100); border-radius: 12px; overflow: hidden; background: var(--surface); }
.host-fleet__detail > header { padding: .875rem 1rem; display: flex; justify-content: space-between; gap: 1rem; align-items: center; border-block-end: 1px solid var(--ink-100); }
.host-fleet__detail h3, .host-fleet__detail p { margin: 0; }
.host-fleet__install {
  border: 1px solid var(--ink-100); border-radius: 8px; padding: .375rem .75rem; display: inline-flex; gap: .375rem; align-items: center;
  background: var(--surface); cursor: pointer;
}
@media (max-width: 899px) { .host-fleet__grid { grid-template-columns: minmax(0, 1fr); } }
</style>
