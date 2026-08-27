<script setup lang="ts">
import { RefreshCw, Search, ShieldCheck, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, api } from "../../api";
import { translate as tr } from "../../i18n";
import {
  formatFingerprint,
  TLS_MANUAL_PROBE_COOLDOWN_MS,
  type CertificateProbeResponse,
  type SslCertificateAsset,
} from "../../../shared/tls-certificates";

interface EnvironmentOption { id: string; name: string }
interface SshOption { id: string; name: string; environmentIds: string[] }
const route = useRoute();
const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const items = ref<SslCertificateAsset[]>([]);
const summary = ref({ total: 0, valid: 0, expiring: 0, expired: 0, error: 0, orphan: 0 });
const environments = ref<EnvironmentOption[]>([]);
const sshConnections = ref<SshOption[]>([]);
const query = reactive({ q: "", status: "", environmentId: "", sort: "expiry" as "expiry" | "name" | "updated" });
const createDialog = ref(false);
const createForm = reactive({ host: "", port: 443, sni: "", environmentId: "", sshConnectionId: "" as string | null, observeEnabled: true });
const highlighted = computed(() => String(route.query.fingerprint ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase());
const batch = reactive({
  running: false,
  current: 0,
  total: 0,
  succeeded: 0,
  failed: 0,
  cooldownUntil: 0,
  failures: [] as Array<{ id: string; name: string; message: string; asset: SslCertificateAsset }>,
});
const cooldownNow = ref(Date.now());
let cooldownTimer: ReturnType<typeof setInterval> | null = null;
const batchBusy = computed(() => batch.running || saving.value);
const batchCooldownActive = computed(() => cooldownNow.value < batch.cooldownUntil);
const batchPercent = computed(() => batch.total ? Math.round((batch.current / batch.total) * 100) : 0);
const batchSummaryText = computed(() => `${tr("正在重新探测 {{0}} / {{1}}", [batch.current, batch.total])} · ${tr("成功 {{0}}", [batch.succeeded])} · ${tr("失败 {{0}}", [batch.failed])}`);

const sshOptions = computed(() => sshConnections.value.filter((item) => !createForm.environmentId || item.environmentIds.includes(createForm.environmentId)));

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
    if (query.environmentId) params.set("environmentId", query.environmentId);
    params.set("sort", query.sort);
    params.set("pageSize", "100");
    const response = await api<{ items: SslCertificateAsset[]; summary: typeof summary.value }>(`/api/v1/certificates?${params.toString()}`);
    items.value = response.items;
    summary.value = response.summary;
    await scrollToHighlighted();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载证书失败"));
  } finally {
    loading.value = false;
  }
}

async function loadLookups() {
  const [envRes, connRes] = await Promise.all([
    api<{ items: EnvironmentOption[] }>("/api/v1/environments"),
    api<{ items: SshOption[] }>("/api/v1/connections?type=ssh"),
  ]);
  environments.value = envRes.items;
  sshConnections.value = connRes.items;
}

function openCreate() {
  Object.assign(createForm, { host: "", port: 443, sni: "", environmentId: environments.value[0]?.id ?? "", sshConnectionId: "", observeEnabled: true });
  createDialog.value = true;
}

async function createEndpoint() {
  if (!createForm.host.trim() || !createForm.environmentId) return ElMessage.warning(tr("请填写探测主机并选择环境"));
  saving.value = true;
  try {
    const created = await api<{ id: string; item?: { id: string; sshConnectionId: string | null } }>(`/api/v1/environments/${createForm.environmentId}/tls-endpoints`, {
      method: "POST",
      body: JSON.stringify({
        host: createForm.host,
        port: createForm.port,
        sni: createForm.sni,
        sshConnectionId: createForm.sshConnectionId || null,
        observeEnabled: createForm.observeEnabled,
      }),
    });
    const endpointId = created.item?.id ?? created.id;
    if (endpointId && (created.item?.sshConnectionId || createForm.sshConnectionId)) {
      await api(`/api/v1/tls-endpoints/${endpointId}/probe`, { method: "POST" }).catch(() => undefined);
    }
    createDialog.value = false;
    ElMessage.success(tr("探测端点已登记"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("登记探测端点失败"));
  } finally {
    saving.value = false;
  }
}

function probeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return tr("重新探测失败");
}

function stopCooldownTimer() {
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = null;
}

function startBatchCooldown(now: number) {
  batch.cooldownUntil = now + TLS_MANUAL_PROBE_COOLDOWN_MS;
  cooldownNow.value = now;
  stopCooldownTimer();
  cooldownTimer = setInterval(() => {
    cooldownNow.value = Date.now();
    if (!batchCooldownActive.value) stopCooldownTimer();
  }, 250);
}

function probeResponseError(response: CertificateProbeResponse): string | null {
  const failures = response.results?.filter((result) => result.status === "failed") ?? [];
  if (!(response.failed ?? failures.length)) return null;
  const messages = failures
    .map((result) => result.message || result.error)
    .filter((message): message is string => Boolean(message));
  return messages.length ? [...new Set(messages)].join("；") : tr("重新探测失败");
}

async function requestCertificateProbe(asset: SslCertificateAsset): Promise<CertificateProbeResponse> {
  const response = await api<CertificateProbeResponse>(`/api/v1/certificates/${asset.id}/probe`, { method: "POST" });
  const failure = probeResponseError(response);
  if (failure) throw new Error(failure);
  return response;
}

async function probeAsset(asset: SslCertificateAsset) {
  if (batch.running) return;
  saving.value = true;
  try {
    await requestCertificateProbe(asset);
    ElMessage.success(tr("证书探测已完成"));
    await load();
  } catch (error) {
    ElMessage.error(probeErrorMessage(error));
    await load();
  } finally {
    saving.value = false;
  }
}

async function probeAll(targets?: SslCertificateAsset[]) {
  if (batch.running) return;
  const now = Date.now();
  cooldownNow.value = now;
  if (batchCooldownActive.value) {
    const seconds = Math.ceil((batch.cooldownUntil - now) / 1000);
    ElMessage.warning(tr("批量重新探测冷却中，请 {{0}} 秒后再试", [seconds]));
    return;
  }
  const queue = (targets?.length ? targets : items.value).slice();
  if (!queue.length) return;
  batch.running = true;
  batch.current = 0;
  batch.total = queue.length;
  batch.succeeded = 0;
  batch.failed = 0;
  batch.failures = [];
  startBatchCooldown(now);
  try {
    for (const asset of queue) {
      try {
        await requestCertificateProbe(asset);
        batch.succeeded += 1;
      } catch (error) {
        batch.failed += 1;
        batch.failures.push({
          id: asset.id,
          name: asset.leafCn || asset.fingerprintSha256.slice(0, 16),
          message: probeErrorMessage(error),
          asset,
        });
      } finally {
        batch.current += 1;
      }
    }
    await load();
    if (batch.failed === 0) ElMessage.success(tr("批量重新探测已完成"));
    else if (batch.succeeded === 0) ElMessage.error(tr("批量重新探测全部失败"));
    else ElMessage.warning(tr("批量重新探测部分完成：成功 {{0}}，失败 {{1}}", [batch.succeeded, batch.failed]));
  } finally {
    batch.running = false;
  }
}

async function retryFailed() {
  const targets = [...new Map(batch.failures.map((item) => [item.id, item.asset])).values()];
  await probeAll(targets);
}

async function removeAsset(asset: SslCertificateAsset) {
  try {
    const cascade = asset.endpointCount > 0;
    await ElMessageBox.confirm(
      cascade
        ? tr("该证书当前正保护 {{0}} 个 Web 入口。删除后将移除这些入口的证书关联与到期监控，但不会影响实际网络连接。确认删除？", [asset.webEntryCount])
        : tr("删除证书“{{0}}”？删除后无法恢复。", [asset.leafCn || asset.fingerprintSha256.slice(0, 16)]),
      tr("删除证书记录"),
      { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" },
    );
    await api(`/api/v1/certificates/${asset.id}${cascade ? "?cascade=endpoints" : ""}`, { method: "DELETE" });
    ElMessage.success(tr("证书已删除"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除证书失败"));
  }
}

function statusLabel(asset: SslCertificateAsset) {
  if (asset.status === "expired") return tr("已过期");
  if (asset.status === "expiring") return tr("剩余 {{0}} 天", [asset.daysRemaining ?? 0]);
  if (asset.status === "error") return tr("探测异常");
  if (asset.status === "orphan") return tr("待关联");
  return tr("正常有效 · 剩余 {{0}} 天", [asset.daysRemaining ?? 0]);
}

async function scrollToHighlighted() {
  const value = highlighted.value;
  if (!value || !items.value.length) return;
  await nextTick();
  document.getElementById(`certificate-${value}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

watch(query, () => { void load(); }, { deep: true });
watch(highlighted, async (value) => {
  if (!value || !items.value.length) return;
  await router.replace({ query: { ...route.query, tab: "ssl", fingerprint: value } });
  await scrollToHighlighted();
});

onMounted(async () => {
  await loadLookups();
  await load();
});
onUnmounted(stopCooldownTimer);

defineExpose({ openCreate, probeAll, retryFailed, batchBusy });
</script>

<template>
  <div class="certificate-center" v-loading="loading">
    <section class="cert-metrics" :aria-label="$t('证书概览')">
      <article><strong>{{ summary.total }}</strong><span>{{ $t('总证书数') }}</span></article>
      <article class="is-valid"><strong>{{ summary.valid }}</strong><span>{{ $t('正常有效') }}</span></article>
      <article class="is-expiring"><strong>{{ summary.expiring }}</strong><span>{{ $t('即将到期') }}</span></article>
      <article class="is-expired"><strong>{{ summary.expired + summary.error }}</strong><span>{{ $t('已过期 / 异常') }}</span></article>
    </section>

    <div v-if="batch.total" class="cert-batch-progress" role="status" :aria-busy="batch.running" data-testid="certificate-batch-progress">
      <div class="cert-batch-progress__bar">
        <progress :max="batch.total" :value="batch.current" />
        <strong>{{ batchPercent }}%</strong>
      </div>
      <p data-testid="certificate-batch-summary">{{ batchSummaryText }}</p>
      <ul v-if="batch.failures.length" data-testid="certificate-batch-failures">
        <li v-for="item in batch.failures" :key="item.id">{{ item.name }}：{{ item.message }}</li>
      </ul>
      <el-button
        v-if="batch.failures.length && !batch.running"
        data-testid="certificate-batch-retry"
        :disabled="batchCooldownActive"
        @click="retryFailed"
      >{{ $t('重试失败项') }}</el-button>
    </div>

    <div class="cert-toolbar">
      <el-input v-model="query.q" clearable :placeholder="$t('搜索域名、颁发者或指纹')" :prefix-icon="Search" />
      <el-select v-model="query.status" clearable :placeholder="$t('状态')">
        <el-option :label="$t('正常有效')" value="valid" />
        <el-option :label="$t('30天内到期')" value="30d" />
        <el-option :label="$t('14天内到期')" value="14d" />
        <el-option :label="$t('7天内到期')" value="7d" />
        <el-option :label="$t('已过期')" value="expired" />
        <el-option :label="$t('探测失败')" value="error" />
        <el-option :label="$t('域名不匹配')" value="mismatch" />
        <el-option :label="$t('待关联')" value="orphan" />
      </el-select>
      <el-select v-model="query.environmentId" clearable :placeholder="$t('环境')">
        <el-option v-for="item in environments" :key="item.id" :label="item.name" :value="item.id" />
      </el-select>
      <el-select v-model="query.sort" style="width: 140px">
        <el-option :label="$t('按到期时间')" value="expiry" />
        <el-option :label="$t('按域名')" value="name" />
        <el-option :label="$t('按更新时间')" value="updated" />
      </el-select>
    </div>

    <section v-if="items.length" class="cert-list">
      <article
        v-for="asset in items"
        :id="`certificate-${asset.fingerprintSha256}`"
        :key="asset.id"
        class="cert-card"
        :class="{ 'is-active': highlighted === asset.fingerprintSha256 }"
      >
        <header>
          <div>
            <h3>{{ asset.leafCn || formatFingerprint(asset.fingerprintSha256) }}</h3>
            <small :class="`is-${asset.status}`">{{ statusLabel(asset) }}</small>
          </div>
          <span>{{ asset.issuer || $t('未知颁发者') }}</span>
        </header>
        <code>{{ formatFingerprint(asset.fingerprintSha256) }}</code>
        <p v-if="asset.leafSans.length">{{ $t('备用域名') }}：{{ asset.leafSans.join(", ") }}</p>
        <p>{{ $t('有效期') }}：{{ asset.notBefore.slice(0, 10) }} {{ $t('至') }} {{ asset.notAfter.slice(0, 10) }}</p>
        <ul v-if="asset.webEntries.length">
          <li v-for="entry in asset.webEntries" :key="entry.id">{{ entry.environmentName }} · {{ entry.name }} ({{ entry.url }})</li>
        </ul>
        <p v-else>{{ $t('待关联 Web 入口') }}</p>
        <footer>
          <el-button text :loading="batchBusy" :disabled="batch.running" @click="probeAsset(asset)"><RefreshCw :size="14" />{{ $t('重新探测全部端点') }}</el-button>
          <el-button text class="is-danger" @click="removeAsset(asset)"><Trash2 :size="14" />{{ $t('删除证书记录') }}</el-button>
        </footer>
      </article>
    </section>
    <div v-else-if="!loading" class="cert-empty">
      <ShieldCheck :size="28" />
      <h3>{{ $t('当前空间还没有 SSL 证书') }}</h3>
      <p>{{ $t('从 HTTPS Web 入口自动发现，或手动录入探测端点。') }}</p>
    </div>

    <el-dialog v-model="createDialog" align-center class="envman-dialog" :title="$t('手动录入端点探测')" width="560px">
      <el-form label-position="top">
        <el-form-item :label="$t('环境')" required>
          <el-select v-model="createForm.environmentId" style="width:100%">
            <el-option v-for="item in environments" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('探测主机')" required><el-input v-model="createForm.host" /></el-form-item>
        <el-form-item :label="$t('端口')"><el-input-number v-model="createForm.port" :min="1" :max="65535" /></el-form-item>
        <el-form-item :label="$t('SNI')"><el-input v-model="createForm.sni" :placeholder="$t('可留空，默认使用主机名')" /></el-form-item>
        <el-form-item :label="$t('SSH 主机')">
          <el-select v-model="createForm.sshConnectionId" clearable style="width:100%">
            <el-option v-for="item in sshOptions" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">{{ $t('取消') }}</el-button>
        <el-button type="primary" :loading="saving" @click="createEndpoint">{{ $t('开始探测') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.certificate-center { min-width: 0; }
.cert-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
.cert-metrics article { padding: 14px 16px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); display: grid; gap: 4px; }
.cert-metrics strong { font-family: var(--font-display); font-size: 22px; color: var(--ink-900); }
.cert-metrics span { font-size: 11px; color: var(--ink-500); }
.cert-metrics .is-valid strong { color: var(--teal-700); }
.cert-metrics .is-expiring strong { color: var(--amber-600, #b46b0d); }
.cert-metrics .is-expired strong { color: var(--red-600, #b7473f); }
.cert-batch-progress { margin-bottom: 14px; padding: 12px 14px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); display: grid; gap: 8px; }
.cert-batch-progress__bar { display: flex; align-items: center; gap: 10px; }
.cert-batch-progress progress { flex: 1; height: 8px; }
.cert-batch-progress p, .cert-batch-progress li { margin: 0; color: var(--ink-500); font-size: 12px; }
.cert-batch-progress ul { margin: 0; padding-left: 16px; }
.cert-toolbar { display: grid; grid-template-columns: minmax(0, 1.4fr) 160px 180px 140px; gap: 8px; margin-bottom: 14px; }
.cert-list { display: grid; gap: 12px; }
.cert-card { padding: 16px 18px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); display: grid; gap: 8px; }
.cert-card.is-active { border-color: var(--teal-500); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal-200) 55%, transparent); }
.cert-card header { display: flex; justify-content: space-between; gap: 12px; }
.cert-card h3 { margin: 0; font-size: 16px; }
.cert-card small { font-size: 11px; font-weight: 800; }
.cert-card .is-valid { color: var(--teal-700); }
.cert-card .is-expiring { color: var(--amber-600, #b46b0d); }
.cert-card .is-expired, .cert-card .is-error { color: var(--red-600, #b7473f); }
.cert-card code { color: var(--teal-700); font-size: 11px; }
.cert-card p, .cert-card li { margin: 0; color: var(--ink-500); font-size: 12px; }
.cert-card ul { margin: 0; padding-left: 16px; }
.cert-card footer { display: flex; gap: 8px; }
.cert-card .is-danger { color: var(--red-500); }
.cert-empty { padding: 48px 20px; border: 1px dashed var(--ink-200); border-radius: 12px; text-align: center; color: var(--ink-500); }
@media (max-width: 900px) {
  .cert-metrics, .cert-toolbar { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px) {
  .cert-metrics, .cert-toolbar { grid-template-columns: 1fr; }
}
</style>
