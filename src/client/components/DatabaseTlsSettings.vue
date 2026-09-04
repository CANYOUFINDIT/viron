<script setup lang="ts">
import { computed } from "vue";
import { translate as tr } from "../i18n";
import ConnectionMethodPicker from "./ConnectionMethodPicker.vue";

const props = withDefaults(defineProps<{
  preservesCredential?: boolean;
  hasTlsCa?: boolean;
  hasTlsCertificate?: boolean;
  hasTlsPrivateKey?: boolean;
  hasTlsPassphrase?: boolean;
}>(), {
  preservesCredential: false,
  hasTlsCa: false,
  hasTlsCertificate: false,
  hasTlsPrivateKey: false,
  hasTlsPassphrase: false,
});

const enabled = defineModel<boolean>("enabled", { required: true });
const rejectUnauthorized = defineModel<boolean>("rejectUnauthorized", { required: true });
const ca = defineModel<string>("ca", { required: true });
const certificate = defineModel<string>("certificate", { required: true });
const privateKey = defineModel<string>("privateKey", { required: true });
const passphrase = defineModel<string>("passphrase", { required: true });

const tlsMode = computed({
  get: () => !enabled.value ? "disabled" : rejectUnauthorized.value ? "verify" : "required",
  set: (value: string) => {
    enabled.value = value !== "disabled";
    rejectUnauthorized.value = value === "verify";
  },
});

const tlsChoices = computed(() => [
  { value: "disabled", title: tr("不使用 TLS"), description: tr("仅用于可信内网或已有独立加密链路。"), badge: tr("明文") },
  { value: "required", title: tr("加密连接"), description: tr("启用 TLS，但不校验服务器证书链。"), badge: tr("兼容") },
  { value: "verify", title: tr("验证服务器"), description: tr("校验证书链，可配置私有 CA 与双向 TLS。"), badge: tr("推荐") },
]);

function credentialPlaceholder(kind: "ca" | "certificate" | "privateKey" | "passphrase"): string {
  if (!props.preservesCredential) return kind === "passphrase" ? tr("可选") : tr("粘贴 PEM 内容，可选");
  const configured = kind === "ca" ? props.hasTlsCa
    : kind === "certificate" ? props.hasTlsCertificate
      : kind === "privateKey" ? props.hasTlsPrivateKey
        : props.hasTlsPassphrase;
  return configured ? tr("已安全保存；留空表示保持不变") : kind === "passphrase" ? tr("可选") : tr("粘贴 PEM 内容，可选");
}
</script>

<template>
  <div class="database-tls-settings form-span-2">
    <ConnectionMethodPicker v-model="tlsMode" :label="$t('TLS 安全策略')" :choices="tlsChoices" />
    <div v-if="enabled" class="database-tls-settings__detail">
      <div class="database-tls-settings__summary">
        <strong>{{ rejectUnauthorized ? $t('服务器身份校验已开启') : $t('当前仅加密传输，不验证服务器身份') }}</strong>
        <span>{{ rejectUnauthorized ? $t('公网与生产环境建议提供私有 CA；需要 mTLS 时再填写客户端证书和私钥。') : $t('适合自签名证书的临时兼容场景，生产环境建议改用“验证服务器”。') }}</span>
      </div>
      <details class="connection-advanced-panel" :open="rejectUnauthorized && Boolean(hasTlsCa || hasTlsCertificate || hasTlsPrivateKey)">
        <summary>
          <span><strong>{{ $t('证书与 mTLS') }}</strong><small>{{ $t('私有 CA、客户端证书、客户端私钥') }}</small></span>
          <span class="connection-advanced-panel__status">{{ hasTlsCa || hasTlsCertificate || hasTlsPrivateKey ? $t('已配置') : $t('可选') }}</span>
        </summary>
        <div class="form-grid form-grid--two connection-advanced-panel__body">
          <el-form-item :label="$t('CA 证书')" class="form-span-2 form-item--code"><el-input v-model="ca" type="textarea" :rows="3" :placeholder="credentialPlaceholder('ca')" /></el-form-item>
          <el-form-item :label="$t('客户端证书')" class="form-span-2 form-item--code"><el-input v-model="certificate" type="textarea" :rows="3" :placeholder="credentialPlaceholder('certificate')" /></el-form-item>
          <el-form-item :label="$t('客户端私钥')" class="form-span-2 form-item--code"><el-input v-model="privateKey" type="textarea" :rows="4" :placeholder="credentialPlaceholder('privateKey')" /></el-form-item>
          <el-form-item :label="$t('私钥口令')" class="form-span-2"><el-input v-model="passphrase" type="password" show-password :placeholder="credentialPlaceholder('passphrase')" /></el-form-item>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.database-tls-settings {
  min-width: 0;
}

.database-tls-settings__detail {
  margin-top: -6px;
}

.database-tls-settings__summary {
  margin-bottom: 10px;
  padding: 11px 13px;
  border-left: 3px solid var(--teal-500);
  border-radius: 0 7px 7px 0;
  background: var(--teal-50);
  color: var(--ink-600);
  display: grid;
  gap: 3px;
  font-size: 12px;
  line-height: 1.5;
}

.database-tls-settings__summary strong {
  color: var(--ink-800);
  font-size: 12px;
}

.connection-advanced-panel {
  overflow: hidden;
  border: 1px solid var(--ink-200);
  border-radius: 9px;
  background: var(--surface);
}

.connection-advanced-panel > summary {
  min-height: 52px;
  padding: 10px 13px;
  color: var(--ink-700);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  list-style: none;
}

.connection-advanced-panel > summary::-webkit-details-marker { display: none; }
.connection-advanced-panel > summary > span:first-child { display: grid; gap: 2px; }
.connection-advanced-panel > summary strong { font-size: 13px; }
.connection-advanced-panel > summary small { color: var(--ink-400); font-size: 11px; }

.connection-advanced-panel__status {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--ink-50);
  color: var(--ink-500);
  font-size: 10px;
  font-weight: 700;
}

.connection-advanced-panel__body {
  padding: 14px 13px 0;
  border-top: 1px solid var(--ink-100);
}
</style>
