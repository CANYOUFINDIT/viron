<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

interface WindowDetail {
  code: string;
  name: string;
  channel: "operation" | "mcp" | "agent" | "webPlugins";
  resourceType: string;
  resourceId: string;
  resourceName: string;
  permanent: boolean;
  expiresAt: string | null;
}

interface OperationWindowData {
  permanent?: boolean;
  partial?: boolean;
  expiresAt?: string | null;
  label?: string | null;
  serverNow?: string;
  details?: WindowDetail[];
}

const props = defineProps<{ window?: OperationWindowData | null }>();
const emit = defineEmits<{ expired: [] }>();
const tick = ref(0);
const receivedAt = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const emitted = new Set<string>();
const seenOpen = new Set<string>();

watch(() => props.window?.serverNow, () => {
  receivedAt.value = Date.now();
  emitted.clear();
}, { immediate: true });

onMounted(() => {
  timer = setInterval(() => { tick.value += 1; }, 1000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

const correctedNow = computed(() => {
  tick.value;
  const server = props.window?.serverNow ? Date.parse(props.window.serverNow) : Number.NaN;
  const offset = Number.isFinite(server) ? server - receivedAt.value : 0;
  return Date.now() + offset;
});

function active(expiresAt: string | null | undefined, permanent?: boolean) {
  if (permanent || !expiresAt) return Boolean(permanent);
  return Date.parse(expiresAt) > correctedNow.value;
}

const operationRows = computed(() => (props.window?.details ?? []).filter((row) => row.channel === "operation"));
const activeOperations = computed(() => operationRows.value.filter((row) => active(row.expiresAt, row.permanent)));

const headline = computed(() => {
  const rows = activeOperations.value;
  if (!rows.length) return "";
  if (rows.every((row) => row.permanent)) return "";
  const limited = rows.filter((row) => !row.permanent && row.expiresAt);
  if (!limited.length) return "";
  const expiresAt = Math.min(...limited.map((row) => Date.parse(row.expiresAt!)));
  const partial = rows.some((row) => row.permanent) || new Set(limited.map((row) => row.expiresAt)).size > 1;
  const minutes = Math.max(1, Math.ceil((expiresAt - correctedNow.value) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const amount = hours && rest ? `${hours} 小时 ${rest} 分` : hours ? `${hours} 小时` : `${rest} 分`;
  return `${partial ? "部分操作剩余" : "可操作剩余"} ${amount}`;
});

watch(correctedNow, () => {
  for (const row of props.window?.details ?? []) {
    if (row.permanent || !row.expiresAt) continue;
    const key = `${row.channel}:${row.resourceId}:${row.code}:${row.expiresAt}`;
    const open = Date.parse(row.expiresAt) > correctedNow.value;
    if (open) seenOpen.add(key);
    else if (seenOpen.has(key) && !emitted.has(key)) {
      emitted.add(key);
      emit("expired");
    }
  }
});

const rows = computed(() => (props.window?.details ?? []).map((row) => {
  const open = active(row.expiresAt, row.permanent);
  const when = row.permanent ? "永久" : open ? `至 ${new Date(row.expiresAt!).toLocaleString()}` : "已到期";
  return { ...row, key: `${row.channel}:${row.resourceId}:${row.code}`, when, open };
}));

const visible = computed(() => Boolean(headline.value || rows.value.length || props.window?.label));
</script>

<template>
  <span v-if="visible" class="operation-window">
    <small v-if="headline || window?.label" class="environment-card__remaining">{{ headline || window?.label }}</small>
    <details v-if="rows.length" class="operation-window__details">
      <summary>操作明细</summary>
      <ul>
        <li v-for="row in rows" :key="row.key" :data-operation-code="row.code" :data-operation-open="row.open ? 'true' : 'false'">
          <span>{{ row.resourceName }}</span>
          <span>{{ row.name }}</span>
          <code>{{ row.code }}</code>
          <span>{{ row.when }}</span>
        </li>
      </ul>
    </details>
  </span>
</template>
