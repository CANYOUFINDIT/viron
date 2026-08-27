<script setup lang="ts">
import { computed } from "vue";
import { translate as tr } from "../../i18n";
import type { TlsWebEntryStatus } from "../../../shared/tls-certificates";

const props = defineProps<{
  status?: TlsWebEntryStatus | "ok" | "unbound" | "unknown" | null;
  daysRemaining?: number | null;
  stale?: boolean;
  probing?: boolean;
}>();

const normalized = computed<TlsWebEntryStatus>(() => {
  if (props.probing) return "probing";
  if (props.status === "ok") return "valid";
  if (props.status === "unbound" || props.status === "unknown") return "unconfigured";
  return (props.status as TlsWebEntryStatus | undefined) || "unconfigured";
});

const label = computed(() => {
  const status = normalized.value;
  if (status === "probing") return tr("探测中...");
  if (status === "expired") return tr("证书已过期");
  if (status === "expiring") return tr("{{0}} 天后到期", [props.daysRemaining ?? 0]);
  if (status === "mismatch") return tr("域名不匹配");
  if (status === "error") return tr("探测异常");
  if (status === "unconfigured") return tr("未配置探测");
  if (status === "valid") return tr("剩余 {{0}} 天", [props.daysRemaining ?? 0]);
  return tr("未配置探测");
});
</script>

<template>
  <span class="tls-status-badge" :class="[`is-${normalized}`, { 'is-stale': stale }]" role="button" tabindex="0">
    {{ label }}
  </span>
</template>

<style scoped>
.tls-status-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.is-valid { background: var(--teal-50); color: var(--teal-700); border-color: color-mix(in srgb, var(--teal-300) 55%, transparent); }
.is-expiring, .is-mismatch { background: var(--amber-100, #fef3c7); color: var(--amber-600, #b46b0d); }
.is-expired { background: var(--red-100, #fee2e2); color: var(--red-600, #b7473f); }
.is-error, .is-unconfigured { background: var(--ink-50); color: var(--ink-500); border-style: dashed; border-color: var(--ink-200); }
.is-probing { background: var(--teal-50); color: var(--teal-700); }
.is-stale { box-shadow: inset 0 0 0 1px var(--amber-600, #b46b0d); }
</style>
