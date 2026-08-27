<script setup lang="ts">
import { RefreshCw, ShieldCheck } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { translate as tr } from "../../i18n";
import { session } from "../../session";
import { formatFingerprint, type TlsWebEntryBadge } from "../../../shared/tls-certificates";
import TlsStatusBadge from "./TlsStatusBadge.vue";

const props = defineProps<{
  tls: TlsWebEntryBadge;
  entryName?: string;
  relatedEntries?: Array<{ id: string; name: string; url: string }>;
}>();
const emit = defineEmits<{ refreshed: [] }>();

const router = useRouter();
const probing = ref(false);
const canManage = computed(() => ["owner", "admin"].includes(session.workspace?.role ?? ""));

async function probe() {
  if (!props.tls.endpointId || !canManage.value) return;
  probing.value = true;
  try {
    await api(`/api/v1/tls-endpoints/${props.tls.endpointId}/probe`, { method: "POST" });
    ElMessage.success(tr("证书探测已完成"));
    emit("refreshed");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("重新探测失败"));
  } finally {
    probing.value = false;
  }
}

async function copyFingerprint() {
  if (!props.tls.fingerprintSha256) return;
  await copyTextToClipboard(formatFingerprint(props.tls.fingerprintSha256));
  ElMessage.success(tr("指纹已复制"));
}

function openCenter() {
  const fingerprint = props.tls.fingerprintSha256 || "";
  void router.push({ name: "ssh-keys", query: { tab: "ssl", fingerprint } });
}
</script>

<template>
  <el-popover placement="bottom-end" :width="360" trigger="click" :show-arrow="true">
    <template #reference>
      <TlsStatusBadge :status="tls.status" :days-remaining="tls.daysRemaining" :stale="tls.stale" :probing="probing" />
    </template>
    <div class="tls-popover">
      <header>
        <strong>{{ $t('SSL 证书详情') }}</strong>
      </header>
      <dl>
        <div><dt>{{ $t('状态') }}</dt><dd>
          <TlsStatusBadge :status="tls.status" :days-remaining="tls.daysRemaining" :stale="tls.stale" :probing="probing" />
        </dd></div>
        <div v-if="tls.fingerprintSha256"><dt>{{ $t('SHA-256 指纹') }}</dt><dd><button type="button" @click="copyFingerprint">{{ formatFingerprint(tls.fingerprintSha256) }}</button></dd></div>
        <div v-if="tls.probedAt"><dt>{{ $t('上次探测') }}</dt><dd>{{ tls.probedAt }}</dd></div>
        <div v-if="tls.stale"><dt>{{ $t('数据状态') }}</dt><dd>{{ $t('探测结果已陈旧') }}</dd></div>
        <div v-if="tls.probeError"><dt>{{ $t('探测错误') }}</dt><dd class="is-error">{{ tls.probeError }}</dd></div>
      </dl>
      <section v-if="relatedEntries?.length">
        <h4>{{ $t('本证书同时保护的其它入口') }}</h4>
        <p v-for="entry in relatedEntries" :key="entry.id">{{ entry.name }} · {{ entry.url }}</p>
      </section>
      <footer>
        <el-button :loading="probing" :disabled="!canManage || !tls.endpointId" :title="canManage ? undefined : $t('需要管理员权限')" @click="probe">
          <RefreshCw :size="14" />{{ $t('立即重新探测') }}
        </el-button>
        <el-button v-if="canManage" type="primary" plain @click="openCenter">
          <ShieldCheck :size="14" />{{ $t('在凭据中心管理') }}
        </el-button>
      </footer>
    </div>
  </el-popover>
</template>

<style scoped>
.tls-popover { display: grid; gap: 10px; color: var(--ink-800); }
.tls-popover header strong { font-size: 13px; }
.tls-popover dl { margin: 0; display: grid; gap: 6px; }
.tls-popover dl > div { display: grid; gap: 2px; }
.tls-popover dt { color: var(--ink-400); font-size: 10px; font-weight: 700; }
.tls-popover dd { margin: 0; font-size: 12px; word-break: break-all; }
.tls-popover dd button { padding: 0; border: 0; background: none; color: var(--teal-700); cursor: pointer; font: inherit; text-align: left; }
.tls-popover .is-error { color: var(--red-600, #b7473f); }
.tls-popover h4 { margin: 0 0 6px; font-size: 11px; }
.tls-popover p { margin: 0; color: var(--ink-500); font-size: 11px; }
.tls-popover footer { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
