<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { OperationWindowData } from "../../shared/operation-window";
import { session } from "../session";

const props = defineProps<{ window?: OperationWindowData | null }>();
const emit = defineEmits<{ expired: [] }>();
const tick = ref(0);
const anchorServer = ref(0);
const anchorPerf = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
const emitted = new Set<string>();
const seenOpen = new Set<string>();

watch(() => props.window?.serverNow, (value) => {
  anchorServer.value = value ? Date.parse(value) : Date.now();
  anchorPerf.value = performance.now();
  emitted.clear();
  seenOpen.clear();
}, { immediate: true });

function onVisible() {
  if (document.visibilityState === "visible") emit("expired");
}

onMounted(() => {
  timer = setInterval(() => { tick.value += 1; }, 1000);
  document.addEventListener("visibilitychange", onVisible);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisible);
});

let permissionsReady = false;
watch(() => `${session.workspace?.id ?? ""}:${session.workspace?.permissionCodes?.join("\0") ?? ""}`, () => {
  if (!permissionsReady) {
    permissionsReady = true;
    return;
  }
  emit("expired");
}, { immediate: true });

const correctedNow = computed(() => {
  tick.value;
  if (!Number.isFinite(anchorServer.value)) return performance.now();
  return anchorServer.value + (performance.now() - anchorPerf.value);
});

function stillOpen(expiresAt: string | null | undefined, permanent?: boolean) {
  if (permanent) return true;
  if (!expiresAt) return false;
  return Date.parse(expiresAt) > correctedNow.value;
}

function amount(expiresAt: string) {
  const minutes = Math.max(1, Math.ceil((Date.parse(expiresAt) - correctedNow.value) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} 小时 ${rest} 分`;
  if (hours) return `${hours} 小时`;
  return `${rest} 分`;
}

function boundaryText(permanent: boolean | undefined, expiresAt: string | null | undefined, allowed = true) {
  if (!allowed) return "未授权";
  if (permanent) return "永久";
  if (!expiresAt) return "无截止";
  if (Date.parse(expiresAt) <= correctedNow.value) return "已到期";
  return `剩余 ${amount(expiresAt)}`;
}

const operationRows = computed(() => (props.window?.details ?? []).filter((row) => row.channel === "operation"));
const activeOperations = computed(() => operationRows.value.filter((row) => stillOpen(row.expiresAt, row.permanent)));

const headline = computed(() => {
  const rows = activeOperations.value;
  if (!rows.length) return "";
  if (rows.every((row) => row.permanent)) return "";
  const limited = rows.filter((row) => !row.permanent && row.expiresAt && stillOpen(row.expiresAt, false));
  if (!limited.length) return "";
  const partial = rows.some((row) => row.permanent) || new Set(limited.map((row) => row.expiresAt)).size > 1;
  const soonest = limited.reduce((left, right) => Date.parse(left.expiresAt!) <= Date.parse(right.expiresAt!) ? left : right);
  return `${partial ? "部分操作剩余" : "可操作剩余"} ${amount(soonest.expiresAt!)}`;
});

watch(correctedNow, () => {
  for (const row of props.window?.details ?? []) {
    const stamps = [row.expiresAt, row.operationExpiresAt, row.featureExpiresAt];
    for (const stamp of stamps) {
      if (!stamp) continue;
      const key = `${row.channel}:${row.resourceId}:${row.code}:${stamp}`;
      const open = Date.parse(stamp) > correctedNow.value;
      if (open) seenOpen.add(key);
      else if (seenOpen.has(key) && !emitted.has(key)) {
        emitted.add(key);
        emit("expired");
      }
    }
  }
});

const rows = computed(() => (props.window?.details ?? []).map((row) => {
  const open = row.channel === "operation" ? stillOpen(row.expiresAt, row.permanent) : Boolean(row.featureAllowed) && stillOpen(row.expiresAt, row.permanent);
  const when = row.channel === "operation"
    ? boundaryText(row.permanent, row.expiresAt, true)
    : `操作${boundaryText(row.operationPermanent, row.operationExpiresAt)}，功能${boundaryText(row.featurePermanent, row.featureExpiresAt, row.featureAllowed !== false)}，渠道${open ? boundaryText(row.permanent, row.expiresAt) : "不可用"}`;
  return { ...row, key: `${row.channel}:${row.resourceId}:${row.code}`, when, open };
}));

const visible = computed(() => Boolean(headline.value || rows.value.length || props.window?.label));

function isolate(event: Event) {
  event.stopPropagation();
}
</script>

<template>
  <span v-if="visible" class="operation-window" @click="isolate" @mousedown="isolate" @pointerdown="isolate" @keydown="isolate" @keyup="isolate">
    <small v-if="headline || window?.label" class="environment-card__remaining">{{ headline || window?.label }}</small>
    <details v-if="rows.length" class="operation-window__details">
      <summary>操作明细</summary>
      <ul>
        <li v-for="row in rows" :key="row.key" :data-operation-open="row.open ? 'true' : 'false'">
          <span>{{ row.resourceName }}</span>
          <span>{{ row.name }}</span>
          <span>{{ row.when }}</span>
        </li>
      </ul>
    </details>
  </span>
</template>
