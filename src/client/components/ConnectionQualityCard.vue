<script setup lang="ts">
import { Gauge, RefreshCw, Route, Server, Wifi, WifiOff } from "@lucide/vue";
import { computed } from "vue";
import type {
  ConnectionQualityOverlayState,
  ConnectionQualityTargetLink,
} from "../../shared/connection-quality";

const props = defineProps<{ state: ConnectionQualityOverlayState }>();
const emit = defineEmits<{
  runTest: [];
  selectTarget: [targetId: string];
  panelClickCapture: [event: MouseEvent];
  panelPointerdown: [event: PointerEvent];
  panelPointermove: [event: PointerEvent];
  panelPointerup: [event: PointerEvent];
  panelPointercancel: [event: PointerEvent];
}>();

const targetDetail = computed(() => props.state.target?.detail || "—");
const targetIsLocal = computed(() => props.state.target?.executionMode === "local");

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(bytesPerSecond >= 10 * 1024 * 1024 ? 0 : 1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(bytesPerSecond >= 100 * 1024 ? 0 : 1)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value}`;
}

function typeLabel(type: ConnectionQualityTargetLink["type"]): string {
  if (type === "web") return "WEB";
  if (type === "database") return "DB";
  return type.toUpperCase();
}

function routeText(link: ConnectionQualityTargetLink): string {
  return link.executionMode === "local" ? "本机直连" : "服务端转发";
}

</script>

<template>
  <section
    class="connection-quality-card"
    :class="[`is-${state.service.status}`, { 'is-expanded': state.expanded, 'is-dragging': state.dragging }]"
    data-connection-quality-card
    :aria-label="$t('连接质量监控')"
    :aria-grabbed="state.dragging"
    @click.capture="emit('panelClickCapture', $event)"
    @pointerdown="emit('panelPointerdown', $event)"
    @pointermove="emit('panelPointermove', $event)"
    @pointerup="emit('panelPointerup', $event)"
    @pointercancel="emit('panelPointercancel', $event)"
  >
    <div class="connection-quality-card__noise" aria-hidden="true"></div>

    <div class="connection-quality-card__links">
      <article class="connection-link" :class="`is-${state.service.status}`">
        <div class="connection-link__route"><Wifi :size="13" /><span>{{ $t('本机') }}</span><i></i><span>VIRON</span></div>
        <div class="connection-link__latency"><strong>{{ formatLatency(state.service.latencyMs) }}</strong><small>MS</small></div>
        <div class="connection-link__rates">
          <span><b>↓</b>{{ formatRate(state.service.downloadBytesPerSecond) }}</span>
          <span><b>↑</b>{{ formatRate(state.service.uploadBytesPerSecond) }}</span>
        </div>
      </article>

      <article class="connection-link" :class="`is-${state.target?.status ?? 'idle'}`">
        <div class="connection-link__route"><Wifi v-if="targetIsLocal" :size="13" /><Server v-else :size="13" /><span>{{ targetIsLocal ? $t('本机') : 'VIRON' }}</span><i></i><span :title="targetDetail">{{ state.target?.label || $t('等待目标') }}</span></div>
        <div class="connection-link__latency"><strong>{{ formatLatency(state.target?.latencyMs ?? null) }}</strong><small>MS</small></div>
        <div class="connection-link__rates">
          <template v-if="state.target">
            <span><b>↓</b>{{ formatRate(state.target.downloadBytesPerSecond) }}</span>
            <span><b>↑</b>{{ formatRate(state.target.uploadBytesPerSecond) }}</span>
          </template>
          <span v-else class="is-muted">{{ $t('尚无活动连接') }}</span>
        </div>
      </article>
    </div>

    <div v-if="state.expanded" class="connection-quality-card__details">
      <div class="connection-quality-metrics">
        <div><span>{{ $t('本机链路抖动') }}</span><strong>{{ state.service.jitterMs ?? '—' }}<small> ms</small></strong></div>
        <div><span>{{ $t('请求失败率') }}</span><strong>{{ Math.round(state.service.failureRate * 100) }}<small>%</small></strong></div>
        <div><span>{{ $t('目标链路抖动') }}</span><strong>{{ state.target?.jitterMs ?? '—' }}<small> ms</small></strong></div>
      </div>

      <section class="connection-quality-targets">
        <header><Route :size="13" /><strong>{{ $t('活动目标') }}</strong><small>{{ state.targets.length }}</small></header>
        <div v-if="state.targets.length" class="connection-quality-targets__list">
          <button
            v-for="target in state.targets"
            :key="target.id"
            type="button"
            :class="{ 'is-active': target.id === state.target?.id }"
            @click="emit('selectTarget', target.id)"
          >
            <span><i :class="`is-${target.status}`"></i><strong>{{ target.label }}</strong><small>{{ typeLabel(target.type) }} · {{ $t(routeText(target)) }}</small></span>
            <em>{{ target.latencyMs === null ? '—' : `${target.latencyMs} ms` }}</em>
          </button>
        </div>
        <div v-else class="connection-quality-targets__empty"><WifiOff :size="15" />{{ $t('建立连接后显示目标链路') }}</div>
      </section>

      <footer>
        <span v-if="state.speedTest">
          {{ $t('最近测速') }} · ↓ {{ formatRate(state.speedTest.downloadBytesPerSecond) }} · ↑ {{ formatRate(state.speedTest.uploadBytesPerSecond) }}
        </span>
        <span v-else>{{ $t('速率为最近 5 秒的真实业务吞吐') }}</span>
        <button type="button" :disabled="state.testing" @click="emit('runTest')">
          <RefreshCw v-if="state.testing" class="is-spinning" :size="13" />
          <Gauge v-else :size="13" />{{ state.testing ? $t('正在测速') : $t('立即测速') }}
        </button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.connection-quality-card {
  --quality-accent: #55e3bb;
  --quality-blue: #72b9ff;
  position: relative;
  width: 326px;
  height: 104px;
  overflow: hidden;
  border: 1px solid rgba(178, 235, 221, .18);
  border-radius: 18px 18px 18px 7px;
  background:
    linear-gradient(145deg, rgba(13, 29, 33, .84), rgba(6, 16, 21, .76)),
    rgba(8, 20, 24, .74);
  color: rgba(239, 250, 247, .96);
  box-shadow:
    0 18px 46px rgba(0, 0, 0, .34),
    inset 0 1px rgba(255, 255, 255, .08),
    0 0 0 1px rgba(5, 12, 15, .24);
  font-family: var(--font-ui, "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif);
  backdrop-filter: blur(22px) saturate(145%);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
  cursor: grab;
  touch-action: none;
  user-select: none;
  transition: height .24s cubic-bezier(.2, .8, .2, 1), box-shadow .18s ease, transform .18s ease;
}
.connection-quality-card.is-expanded { height: 376px; }
.connection-quality-card.is-dragging { cursor: grabbing; box-shadow: 0 26px 60px rgba(0, 0, 0, .43), 0 0 0 1px rgba(85, 227, 187, .24); transform: scale(1.01); transition: none; }
.connection-quality-card::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: radial-gradient(circle at 12% -10%, rgba(85, 227, 187, .18), transparent 38%), linear-gradient(90deg, transparent, rgba(255, 255, 255, .025), transparent); pointer-events: none; }
.connection-quality-card__noise { position: absolute; inset: 0; opacity: .16; pointer-events: none; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.18'/%3E%3C/svg%3E"); }
.connection-quality-card__links { position: relative; z-index: 1; padding: 9px 10px 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.connection-link { min-width: 0; height: 84px; padding: 9px 9px 8px; border: 1px solid rgba(189, 229, 219, .10); border-radius: 11px 11px 11px 4px; background: rgba(255, 255, 255, .035); box-shadow: inset 0 1px rgba(255, 255, 255, .025); }
.connection-link.is-poor, .connection-link.is-offline { border-color: rgba(255, 120, 105, .16); }
.connection-link__route { min-width: 0; color: rgba(207, 232, 226, .56); display: flex; align-items: center; gap: 4px; font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 7px; font-weight: 750; letter-spacing: .045em; text-transform: uppercase; }
.connection-link__route svg { flex: 0 0 auto; color: var(--quality-accent); }
.connection-link__route span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-link__route span:last-child { flex: 1; color: rgba(225, 242, 238, .78); }
.connection-link__route i { width: 12px; height: 1px; flex: 0 0 auto; background: linear-gradient(90deg, var(--quality-accent), rgba(114, 185, 255, .65)); position: relative; }
.connection-link__route i::after { content: ""; position: absolute; top: -1.5px; right: -1px; width: 3px; height: 3px; border-radius: 50%; background: var(--quality-blue); box-shadow: 0 0 7px var(--quality-blue); }
.connection-link__latency { margin-top: 4px; display: flex; align-items: baseline; gap: 3px; }
.connection-link__latency strong { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 23px; line-height: 1; letter-spacing: -.08em; }
.connection-link__latency small { color: rgba(159, 202, 193, .54); font-family: var(--font-mono, monospace); font-size: 7px; font-weight: 800; letter-spacing: .11em; }
.connection-link__rates { margin-top: 7px; color: rgba(202, 226, 220, .65); display: flex; align-items: center; gap: 8px; font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 7px; }
.connection-link__rates span { white-space: nowrap; }
.connection-link__rates b { margin-right: 2px; color: var(--quality-blue); font-weight: 900; }
.connection-link__rates span:nth-child(2) b { color: var(--quality-accent); }
.connection-link__rates .is-muted { color: rgba(189, 214, 208, .4); }
.connection-quality-card__details { position: relative; z-index: 1; padding: 0 10px 12px; }
.connection-quality-metrics { padding: 9px 0 10px; border-top: 1px solid rgba(190, 232, 221, .09); display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.connection-quality-metrics > div { padding: 7px 8px; border-radius: 8px; background: rgba(255, 255, 255, .035); }
.connection-quality-metrics span, .connection-quality-metrics strong { display: block; }
.connection-quality-metrics span { overflow: hidden; color: rgba(192, 218, 212, .5); font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
.connection-quality-metrics strong { margin-top: 4px; font-family: var(--font-mono, monospace); font-size: 12px; }
.connection-quality-metrics strong small { color: rgba(181, 209, 202, .48); font-size: 7px; }
.connection-quality-targets { height: 144px; overflow: hidden; border: 1px solid rgba(190, 232, 221, .10); border-radius: 10px; background: rgba(0, 0, 0, .12); }
.connection-quality-targets > header { height: 31px; padding: 0 9px; border-bottom: 1px solid rgba(190, 232, 221, .08); color: rgba(199, 228, 220, .64); display: flex; align-items: center; gap: 6px; }
.connection-quality-targets > header strong { font-size: 8px; letter-spacing: .06em; }
.connection-quality-targets > header small { margin-left: auto; font-family: var(--font-mono, monospace); font-size: 8px; }
.connection-quality-targets__list { height: 111px; padding: 4px; overflow: auto; scrollbar-width: thin; }
.connection-quality-targets__list button { width: 100%; min-height: 34px; padding: 5px 6px; border: 0; border-radius: 6px; background: transparent; color: rgba(218, 239, 234, .78); display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; cursor: pointer; }
.connection-quality-targets__list button:hover, .connection-quality-targets__list button.is-active { background: rgba(85, 227, 187, .08); color: #fff; }
.connection-quality-targets__list button > span { min-width: 0; display: grid; grid-template-columns: 7px minmax(0, 1fr); column-gap: 7px; }
.connection-quality-targets__list button i { width: 6px; height: 6px; margin-top: 3px; border-radius: 50%; background: rgba(169, 194, 188, .45); }
.connection-quality-targets__list button i.is-good { background: var(--quality-accent); box-shadow: 0 0 6px rgba(85, 227, 187, .65); }
.connection-quality-targets__list button i.is-fair { background: #ffd077; }
.connection-quality-targets__list button i.is-poor, .connection-quality-targets__list button i.is-offline { background: #ff8d7e; }
.connection-quality-targets__list strong, .connection-quality-targets__list small { min-width: 0; grid-column: 2; overflow: hidden; display: block; text-overflow: ellipsis; white-space: nowrap; }
.connection-quality-targets__list strong { font-size: 8px; }
.connection-quality-targets__list small { margin-top: 2px; color: rgba(181, 207, 201, .42); font-family: var(--font-mono, monospace); font-size: 6px; }
.connection-quality-targets__list em { flex: 0 0 auto; color: rgba(160, 224, 207, .66); font-family: var(--font-mono, monospace); font-size: 7px; font-style: normal; }
.connection-quality-targets__empty { height: 111px; color: rgba(181, 207, 201, .44); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 8px; }
.connection-quality-card__details > footer { height: 50px; padding-bottom: 3px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.connection-quality-card__details > footer > span { min-width: 0; overflow: hidden; color: rgba(184, 211, 204, .48); font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
.connection-quality-card__details > footer button { min-width: 80px; height: 27px; padding: 0 9px; border: 1px solid rgba(85, 227, 187, .17); border-radius: 7px; background: rgba(85, 227, 187, .09); color: rgba(208, 247, 237, .84); display: inline-flex; align-items: center; justify-content: center; gap: 5px; font-size: 8px; font-weight: 800; cursor: pointer; }
.connection-quality-card__details > footer button:hover:not(:disabled) { border-color: rgba(85, 227, 187, .35); background: rgba(85, 227, 187, .15); color: #fff; }
.connection-quality-card__details > footer button:disabled { cursor: wait; opacity: .66; }
.is-spinning { animation: connection-quality-spin .85s linear infinite; }
@keyframes connection-quality-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .connection-quality-card { transition: none; } .is-spinning { animation: none; } }
</style>
