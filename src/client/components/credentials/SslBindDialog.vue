<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, reactive, ref, watch } from "vue";
import { ApiError, api } from "../../api";
import { translate as tr } from "../../i18n";
import type { TlsEndpoint } from "../../../shared/tls-certificates";

interface SshOption { id: string; name: string; host?: string; environmentIds: string[] }

const NEW_ID = "__new__";

const props = defineProps<{
  modelValue: boolean;
  environmentId: string;
  entryId: string;
  entryName: string;
  entryUrl: string;
}>();
const emit = defineEmits<{ "update:modelValue": [boolean]; bound: [] }>();

const loading = ref(false);
const saving = ref(false);
const endpoints = ref<TlsEndpoint[]>([]);
const sshConnections = ref<SshOption[]>([]);
const selectedId = ref("");
const createForm = reactive({ host: "", port: 443, sni: "", sshConnectionId: "" as string | null });

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});
const creating = computed(() => selectedId.value === NEW_ID);
const sshOptions = computed(() => sshConnections.value.filter((item) => item.environmentIds.includes(props.environmentId)));
const selectedEndpoint = computed(() => endpoints.value.find((item) => item.id === selectedId.value) ?? null);

function entryOrigin() {
  try {
    const url = new URL(props.entryUrl);
    return { host: url.hostname, sni: url.hostname };
  } catch {
    return { host: "", sni: "" };
  }
}

function endpointLabel(item: TlsEndpoint) {
  const target = `${item.host}:${item.port}`;
  const name = item.leafCn || item.sni || target;
  if (item.leafCn && item.daysRemaining != null) return `${name} · ${tr("剩余 {{0}} 天", [item.daysRemaining])} · ${target}`;
  if (item.leafCn) return `${name} · ${target}`;
  if (item.probeStatus === "never") return `${target} · ${tr("待探测")}`;
  return `${target} · ${item.probeStatus}`;
}

function preselect() {
  const origin = entryOrigin();
  const match = endpoints.value.find((item) => item.host === origin.host || item.sni === origin.host);
  selectedId.value = match?.id || (endpoints.value[0]?.id ?? NEW_ID);
  Object.assign(createForm, {
    host: origin.host,
    port: 443,
    sni: origin.sni,
    sshConnectionId: sshOptions.value.length === 1 ? sshOptions.value[0]!.id : "",
  });
}

async function load() {
  loading.value = true;
  try {
    const [endpointResponse, sshResponse] = await Promise.all([
      api<{ items: TlsEndpoint[] }>(`/api/v1/environments/${props.environmentId}/tls-endpoints`),
      api<{ items: SshOption[] }>("/api/v1/connections?type=ssh"),
    ]);
    endpoints.value = endpointResponse.items;
    sshConnections.value = sshResponse.items;
    preselect();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载 SSL 配置失败"));
  } finally {
    loading.value = false;
  }
}

async function bindEndpoint(endpointId: string, probeReady: boolean) {
  const result = await api<{ endpointId: string | null; tlsProbeReady: boolean }>(`/api/v1/web-entries/${props.entryId}/tls-endpoint`, {
    method: "PUT",
    body: JSON.stringify({ endpointId }),
  });
  open.value = false;
  ElMessage.success(tr("SSL 配置已绑定"));
  emit("bound");
  if (result.tlsProbeReady || probeReady) {
    ElMessage.info(tr("已开始 SSL 证书探测"));
    void api(`/api/v1/tls-endpoints/${endpointId}/probe`, { method: "POST" })
      .then(() => {
        ElMessage.success(tr("SSL 证书探测已完成"));
        emit("bound");
      })
      .catch((error) => {
        ElMessage.warning(error instanceof Error ? error.message : tr("SSL 证书自动探测失败，可稍后重试"));
      });
  }
}

async function save() {
  saving.value = true;
  try {
    if (creating.value) {
      if (!createForm.host.trim()) return ElMessage.warning(tr("请填写探测主机"));
      const created = await api<{ id: string; item?: { id: string; sshConnectionId: string | null } }>(`/api/v1/environments/${props.environmentId}/tls-endpoints`, {
        method: "POST",
        body: JSON.stringify({
          host: createForm.host,
          port: createForm.port,
          sni: createForm.sni,
          sshConnectionId: createForm.sshConnectionId || null,
          observeEnabled: true,
        }),
      });
      const endpointId = created.item?.id ?? created.id;
      await bindEndpoint(endpointId, Boolean(created.item?.sshConnectionId || createForm.sshConnectionId));
      return;
    }
    if (!selectedId.value) return ElMessage.warning(tr("请选择要绑定的 SSL 配置"));
    await bindEndpoint(selectedId.value, Boolean(selectedEndpoint.value?.sshConnectionId));
  } catch (error) {
    if (creating.value && error instanceof ApiError && error.status === 409) {
      const host = createForm.host.trim();
      const sni = createForm.sni.trim() || host;
      const existing = endpoints.value.find((item) => item.host === host && item.port === createForm.port && (item.sni || item.host) === sni);
      if (existing) {
        try {
          await bindEndpoint(existing.id, Boolean(existing.sshConnectionId));
          return;
        } catch (bindError) {
          ElMessage.error(bindError instanceof Error ? bindError.message : tr("绑定 SSL 配置失败"));
          return;
        }
      }
    }
    ElMessage.error(error instanceof Error ? error.message : tr("绑定 SSL 配置失败"));
  } finally {
    saving.value = false;
  }
}

watch(() => props.modelValue, (visible) => {
  if (visible) void load();
});
</script>

<template>
  <el-dialog append-to-body v-model="open" align-center class="envman-dialog" :title="$t('绑定 SSL 配置')" width="560px">
    <el-form label-position="top" v-loading="loading">
      <el-alert class="ssl-config-alert" type="info" :closable="false" show-icon :title="$t('将此 Web 入口绑定到证书探测配置')" :description="$t('选择当前环境中已有的 SSL 探测端点，或新建一个。绑定只关联证书观察，不会改写入口的访问地址。')" />
      <p class="ssl-bind-entry"><strong>{{ entryName }}</strong><span>{{ entryUrl }}</span></p>
      <el-form-item :label="$t('SSL 配置')" required>
        <el-select v-model="selectedId" filterable style="width:100%" :placeholder="$t('选择已有配置或新建')">
          <el-option :label="$t('新建探测端点')" :value="NEW_ID" />
          <el-option v-for="item in endpoints" :key="item.id" :label="endpointLabel(item)" :value="item.id" />
        </el-select>
      </el-form-item>
      <template v-if="creating">
        <el-form-item :label="$t('探测主机')" required><el-input v-model="createForm.host" :placeholder="$t('例如：dev.example.com')" /></el-form-item>
        <el-form-item :label="$t('端口')"><el-input-number v-model="createForm.port" :min="1" :max="65535" /></el-form-item>
        <el-form-item label="SNI"><el-input v-model="createForm.sni" :placeholder="$t('可留空，默认使用主机名')" /></el-form-item>
        <el-form-item :label="$t('SSH 探测主机')">
          <el-select v-model="createForm.sshConnectionId" clearable filterable style="width:100%" :placeholder="$t('选择当前环境中的 SSH 主机')">
            <el-option v-for="item in sshOptions" :key="item.id" :label="item.host ? `${item.name} · ${item.host}` : item.name" :value="item.id" />
          </el-select>
        </el-form-item>
      </template>
      <dl v-else-if="selectedEndpoint" class="ssl-bind-summary">
        <div><dt>{{ $t('探测端点') }}</dt><dd>{{ selectedEndpoint.host }}:{{ selectedEndpoint.port }}</dd></div>
        <div v-if="selectedEndpoint.leafCn"><dt>{{ $t('证书') }}</dt><dd>{{ selectedEndpoint.leafCn }}</dd></div>
        <div v-if="selectedEndpoint.issuer"><dt>{{ $t('颁发者') }}</dt><dd>{{ selectedEndpoint.issuer }}</dd></div>
        <div><dt>{{ $t('探测主机') }}</dt><dd>{{ selectedEndpoint.sshConnectionName || $t('尚未绑定 SSH 主机') }}</dd></div>
      </dl>
    </el-form>
    <template #footer>
      <el-button @click="open = false">{{ $t('取消') }}</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ creating ? $t('创建并绑定') : $t('绑定配置') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ssl-config-alert { margin-bottom: 14px; }
.ssl-bind-entry { margin: 0 0 14px; display: grid; gap: 2px; }
.ssl-bind-entry strong { font-size: 13px; }
.ssl-bind-entry span { overflow: hidden; color: var(--ink-400); font-family: var(--font-mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.ssl-bind-summary { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.ssl-bind-summary dt { color: var(--ink-400); font-size: 10px; font-weight: 700; }
.ssl-bind-summary dd { margin: 4px 0 0; font-size: 12px; word-break: break-word; }
</style>
