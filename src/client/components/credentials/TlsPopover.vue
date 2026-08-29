<script setup lang="ts">
import { Link2, Pencil, RefreshCw, Server, Shield, ShieldAlert, ShieldCheck } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { translate as tr } from "../../i18n";
import { session } from "../../session";
import {
  formatFingerprint,
  type CertificateProbeResponse,
  type SslCertificateAsset,
  type TlsEndpoint,
  type TlsWebEntryBadge,
} from "../../../shared/tls-certificates";
import TlsStatusBadge from "./TlsStatusBadge.vue";

interface SshOption { id: string; name: string; host?: string; environmentIds: string[] }

const props = defineProps<{
  tls?: TlsWebEntryBadge | null;
  entryId?: string;
  entryName?: string;
  entryUrl?: string;
  iconOnly?: boolean;
  relatedEntries?: Array<{ id: string; name: string; url: string }>;
}>();
const emit = defineEmits<{ refreshed: []; configureHttps: [] }>();

const router = useRouter();
const probing = ref(false);
const loadingDetail = ref(false);
const savingBinding = ref(false);
const bindingOpen = ref(false);
const asset = ref<SslCertificateAsset | null>(null);
const endpoint = ref<TlsEndpoint | null>(null);
const sshConnections = ref<SshOption[]>([]);
const bindForm = reactive({ sshConnectionId: "" });
const canManage = computed(() => ["owner", "admin"].includes(session.workspace?.role ?? ""));
const isHttps = computed(() => {
  try {
    return new URL(props.entryUrl || "").protocol === "https:";
  } catch {
    return false;
  }
});
const securityState = computed(() => {
  if (!isHttps.value) return "insecure";
  if (props.tls?.status === "valid") return "secure";
  if (props.tls?.status === "expiring") return "warning";
  if (["expired", "mismatch", "error"].includes(props.tls?.status || "")) return "danger";
  return "pending";
});
const securityLabel = computed(() => {
  if (securityState.value === "secure") return tr("连接安全，查看 SSL 证书");
  if (securityState.value === "warning") return tr("SSL 证书即将到期");
  if (securityState.value === "danger") return tr("SSL 证书存在异常");
  if (securityState.value === "pending") return tr("SSL 证书待配置");
  return tr("连接未启用 SSL");
});
const sshOptions = computed(() => sshConnections.value.filter((item) => !endpoint.value || item.environmentIds.includes(endpoint.value.environmentId)));
const related = computed(() => {
  if (asset.value) {
    return asset.value.webEntries
      .filter((item) => item.id !== props.entryId)
      .map((item) => ({ id: item.id, name: `${item.environmentName} · ${item.name}`, url: item.url }));
  }
  return props.relatedEntries ?? [];
});

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

async function loadDetail() {
  if (!props.tls?.endpointId) {
    endpoint.value = null;
    asset.value = null;
    return;
  }
  loadingDetail.value = true;
  try {
    const endpointResponse = await api<{ item: TlsEndpoint }>(`/api/v1/tls-endpoints/${props.tls.endpointId}`);
    const certificateId = endpointResponse.item.certificateId;
    const [certificateResponse, connectionsResponse] = await Promise.all([
      canManage.value && certificateId
        ? api<{ item: SslCertificateAsset }>(`/api/v1/certificates/${certificateId}`).catch(() => ({ item: null as unknown as SslCertificateAsset }))
        : Promise.resolve({ item: null as unknown as SslCertificateAsset }),
      canManage.value
        ? api<{ items: SshOption[] }>("/api/v1/connections?type=ssh").catch(() => ({ items: [] as SshOption[] }))
        : Promise.resolve({ items: [] as SshOption[] }),
    ]);
    endpoint.value = endpointResponse.item;
    asset.value = certificateResponse.item || null;
    sshConnections.value = connectionsResponse.items;
    bindForm.sshConnectionId = endpoint.value.sshConnectionId ?? "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载证书详情失败"));
  } finally {
    loadingDetail.value = false;
  }
}

async function probe() {
  if (!props.tls?.endpointId || !canManage.value) return;
  if (!endpoint.value) await loadDetail();
  if (!endpoint.value?.sshConnectionId) {
    bindingOpen.value = true;
    return ElMessage.warning(tr("请先选择用于探测的 SSH 主机"));
  }
  probing.value = true;
  try {
    if (endpoint.value.certificateId) {
      const response = await api<CertificateProbeResponse>(`/api/v1/certificates/${endpoint.value.certificateId}/probe`, { method: "POST" });
      if (response.failed) ElMessage.warning(tr("证书端点探测完成：成功 {{0}}，失败 {{1}}", [response.succeeded, response.failed]));
      else ElMessage.success(tr("共享证书的全部端点已完成探测"));
    } else {
      await api(`/api/v1/tls-endpoints/${props.tls.endpointId}/probe`, { method: "POST" });
      ElMessage.success(tr("证书探测已完成"));
    }
    await loadDetail();
    emit("refreshed");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("重新探测失败"));
  } finally {
    probing.value = false;
  }
}

async function saveBinding() {
  if (!endpoint.value || !bindForm.sshConnectionId) return ElMessage.warning(tr("请选择 SSH 主机"));
  savingBinding.value = true;
  try {
    await api(`/api/v1/tls-endpoints/${endpoint.value.id}`, {
      method: "PUT",
      body: JSON.stringify({
        host: endpoint.value.host,
        port: endpoint.value.port,
        sni: endpoint.value.sni,
        sshConnectionId: bindForm.sshConnectionId,
        observeEnabled: true,
      }),
    });
    bindingOpen.value = false;
    ElMessage.success(tr("探测主机已绑定，正在读取证书"));
    await loadDetail();
    await probe();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("绑定探测主机失败"));
  } finally {
    savingBinding.value = false;
  }
}

async function copyFingerprint() {
  const fingerprint = asset.value?.fingerprintSha256 || props.tls?.fingerprintSha256;
  if (!fingerprint) return;
  await copyTextToClipboard(formatFingerprint(fingerprint));
  ElMessage.success(tr("指纹已复制"));
}

function openCenter() {
  const fingerprint = props.tls?.fingerprintSha256 || "";
  void router.push({ name: "ssh-keys", query: { tab: "ssl", fingerprint } });
}
</script>

<template>
  <el-popover :placement="iconOnly ? 'bottom-start' : 'bottom-end'" :width="400" trigger="click" :show-arrow="true" @show="loadDetail">
    <template #reference>
      <span v-if="iconOnly" class="tls-address-control" :class="`is-${securityState}`" role="button" tabindex="0" :aria-label="securityLabel" :title="securityLabel">
        <ShieldCheck v-if="securityState === 'secure'" :size="15" />
        <ShieldAlert v-else-if="securityState === 'warning' || securityState === 'danger' || securityState === 'insecure'" :size="15" />
        <Shield v-else :size="15" />
      </span>
      <TlsStatusBadge
        v-else
        :status="tls?.status || 'unconfigured'"
        :days-remaining="tls?.daysRemaining"
        :stale="tls?.stale"
        :probing="probing"
        :label-prefix="$t('SSL · ')"
        :unconfigured-label="isHttps ? $t('待配置') : $t('未启用')"
      />
    </template>
    <div class="tls-popover" v-loading="loadingDetail">
      <header>
        <span class="tls-popover__mark"><ShieldCheck :size="17" /></span>
        <div><strong>{{ asset?.leafCn || endpoint?.sni || endpoint?.host || entryName || $t('SSL 证书详情') }}</strong><small>{{ entryName }}</small></div>
        <TlsStatusBadge :status="tls?.status || 'unconfigured'" :days-remaining="tls?.daysRemaining" :stale="tls?.stale" :probing="probing" :unconfigured-label="isHttps ? $t('待配置') : $t('未启用')" />
      </header>

      <section v-if="!isHttps" class="tls-disabled-state">
        <ShieldCheck :size="22" />
        <div>
          <strong>{{ $t('当前入口尚未启用 SSL') }}</strong>
          <p>{{ $t('该 Web 入口仍使用 HTTP。切换为 HTTPS 后，系统会自动创建证书探测端点，并在这里持续显示有效期和异常状态。') }}</p>
        </div>
      </section>

      <section v-else-if="!tls?.endpointId" class="tls-disabled-state is-pending">
        <ShieldCheck :size="22" />
        <div>
          <strong>{{ $t('SSL 探测端点尚未建立') }}</strong>
          <p>{{ $t('重新保存入口即可初始化证书探测端点。') }}</p>
        </div>
      </section>

      <dl v-if="tls?.endpointId">
        <div v-if="asset?.issuer"><dt>{{ $t('颁发者') }}</dt><dd>{{ asset.issuer }}</dd></div>
        <div v-if="asset?.notAfter"><dt>{{ $t('有效期') }}</dt><dd>{{ formatDate(asset.notBefore) }} — {{ formatDate(asset.notAfter) }}</dd></div>
        <div v-if="asset?.leafSans.length"><dt>SAN</dt><dd>{{ asset.leafSans.join(', ') }}</dd></div>
        <div v-if="asset?.fingerprintSha256 || tls?.fingerprintSha256"><dt>{{ $t('SHA-256 指纹') }}</dt><dd><button type="button" @click="copyFingerprint">{{ formatFingerprint(asset?.fingerprintSha256 || tls?.fingerprintSha256 || '') }}</button></dd></div>
        <div v-if="endpoint"><dt>{{ $t('探测端点') }}</dt><dd>{{ endpoint.host }}:{{ endpoint.port }}<template v-if="endpoint.sni"> · SNI {{ endpoint.sni }}</template></dd></div>
        <div v-if="endpoint"><dt>{{ $t('探测主机') }}</dt><dd :class="{ 'is-error': !endpoint.sshConnectionId }">{{ endpoint.sshConnectionName || $t('尚未绑定 SSH 主机') }}</dd></div>
        <div v-if="tls?.probedAt"><dt>{{ $t('上次探测') }}</dt><dd>{{ formatDate(tls.probedAt) }}</dd></div>
        <div v-if="tls?.stale"><dt>{{ $t('数据状态') }}</dt><dd>{{ $t('探测结果已陈旧') }}</dd></div>
        <div v-if="tls?.probeError"><dt>{{ $t('探测错误') }}</dt><dd class="is-error">{{ tls.probeError }}</dd></div>
      </dl>

      <section v-if="related.length" class="tls-related">
        <h4><Link2 :size="13" />{{ $t('本证书同时保护的其它入口') }} <small>{{ related.length }}</small></h4>
        <p v-for="entry in related" :key="entry.id"><strong>{{ entry.name }}</strong><span>{{ entry.url }}</span></p>
      </section>

      <section v-if="bindingOpen && endpoint" class="tls-binding">
        <label><Server :size="14" />{{ $t('选择探测 SSH 主机') }}</label>
        <div>
          <el-select v-model="bindForm.sshConnectionId" filterable :placeholder="$t('当前环境中的 SSH 主机')" style="width:100%">
            <el-option v-for="item in sshOptions" :key="item.id" :label="item.host ? `${item.name} · ${item.host}` : item.name" :value="item.id" />
          </el-select>
          <el-button type="primary" :loading="savingBinding" @click="saveBinding">{{ $t('绑定并探测') }}</el-button>
        </div>
        <small v-if="!sshOptions.length">{{ $t('当前环境没有可用 SSH 连接，请先在连接资源池中添加。') }}</small>
      </section>

      <footer>
        <el-button v-if="canManage && tls?.endpointId" :loading="probing" @click="probe">
          <RefreshCw :size="14" />{{ asset ? $t('重新探测全部端点') : $t('立即重新探测') }}
        </el-button>
        <el-button v-if="canManage && endpoint" @click="bindingOpen = !bindingOpen"><Pencil :size="14" />{{ $t('编辑/绑定') }}</el-button>
        <el-button v-if="canManage && !tls?.endpointId" type="primary" @click="emit('configureHttps')"><ShieldCheck :size="14" />{{ isHttps ? $t('初始化 SSL 探测') : $t('启用 HTTPS') }}</el-button>
        <el-button v-if="canManage && isHttps" type="primary" plain @click="openCenter"><ShieldCheck :size="14" />{{ $t('在凭据中心管理') }}</el-button>
      </footer>
    </div>
  </el-popover>
</template>

<style scoped>
.tls-popover { display: grid; gap: 12px; color: var(--ink-800); }
.tls-address-control { width: 24px; height: 24px; margin-left: -3px; flex: 0 0 24px; border-radius: 50%; display: grid; place-items: center; color: var(--ink-400); cursor: pointer; transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out); }
.tls-address-control:hover, .tls-address-control:focus-visible { outline: none; background: var(--ink-50); color: var(--ink-700); }
.tls-address-control.is-secure { color: var(--teal-700); }
.tls-address-control.is-warning { color: var(--amber-600, #b46b0d); }
.tls-address-control.is-danger { color: var(--red-600, #b7473f); }
.tls-address-control.is-insecure { color: var(--ink-400); }
.tls-address-control.is-pending { color: var(--ink-500); }
.tls-popover > header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; padding-bottom: 10px; border-bottom: 1px solid var(--ink-100); }
.tls-popover > header > div { min-width: 0; display: grid; gap: 2px; }
.tls-popover > header strong { overflow: hidden; text-overflow: ellipsis; font-size: 13px; white-space: nowrap; }
.tls-popover > header small { color: var(--ink-400); font-size: 10px; }
.tls-popover__mark { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--teal-200); border-radius: 8px; background: var(--teal-50); color: var(--teal-700); }
.tls-popover dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 9px 14px; }
.tls-popover dl > div { min-width: 0; display: grid; gap: 3px; }
.tls-popover dt { color: var(--ink-400); font-size: 10px; font-weight: 700; }
.tls-popover dd { margin: 0; font-size: 11px; word-break: break-word; }
.tls-popover dd button { padding: 0; border: 0; background: none; color: var(--teal-700); cursor: pointer; font: inherit; text-align: left; }
.tls-popover .is-error { color: var(--red-600, #b7473f); }
.tls-disabled-state { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; padding: 12px; border: 1px dashed var(--ink-200); border-radius: 9px; background: var(--ink-50); color: var(--ink-400); }
.tls-disabled-state.is-pending { border-color: var(--teal-200); background: var(--teal-50); color: var(--teal-700); }
.tls-disabled-state strong { color: var(--ink-700); font-size: 12px; }
.tls-disabled-state p { margin: 4px 0 0; color: var(--ink-500); font-size: 10px; line-height: 1.6; }
.tls-related { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--ink-100); border-radius: 9px; background: var(--ink-50); }
.tls-related h4 { margin: 0; display: flex; align-items: center; gap: 5px; font-size: 11px; }
.tls-related h4 small { color: var(--ink-400); }
.tls-related p { margin: 0; display: grid; gap: 1px; }
.tls-related p strong { font-size: 11px; }
.tls-related p span { overflow: hidden; color: var(--ink-400); font-family: var(--font-mono); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.tls-binding { display: grid; gap: 7px; padding: 10px; border: 1px solid var(--teal-200); border-radius: 9px; background: var(--teal-50); }
.tls-binding label { display: flex; align-items: center; gap: 5px; color: var(--teal-700); font-size: 11px; font-weight: 800; }
.tls-binding > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.tls-binding small { color: var(--ink-500); font-size: 10px; }
.tls-popover footer { display: flex; flex-wrap: wrap; gap: 7px; padding-top: 2px; }
</style>
