<script setup lang="ts">import { currentLocale, translate as tr } from "../i18n";

import { Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { onMounted, ref } from "vue";
import { api } from "../api";
import { copyTextToClipboard } from "../clipboard";
import { activeApiKeys } from "../api-key-list";
import McpApprovalModeSelector from "./McpApprovalModeSelector.vue";
import type { McpApprovalMode } from "../../shared/mcp-settings";

interface ApiKeyItem {
  id: string;
  type: "platform" | "personal";
  name: string;
  keyPrefix: string;
  mcpApprovalMode: McpApprovalMode;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface IssuedApiKey extends ApiKeyItem {
  apiKey: string;
}

const props = defineProps<{ isPlatformAdmin: boolean }>();
const loading = ref(true);
const saving = ref(false);
const personalKeys = ref<ApiKeyItem[]>([]);
const platformKeys = ref<ApiKeyItem[]>([]);
const personalName = ref("");
const personalApprovalMode = ref<McpApprovalMode>("always");
const platformName = ref("");
const revealedKey = ref<IssuedApiKey | null>(null);

function formatTime(value: string | null): string {
  if (!value) return tr("从未使用");
  return new Intl.DateTimeFormat(currentLocale(), {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

async function loadKeys() {
  loading.value = true;
  try {
    const tasks: Promise<void>[] = [
      api<{ items: ApiKeyItem[] }>("/api/v1/api-keys").then((response) => { personalKeys.value = activeApiKeys(response.items); }),
    ];
    if (props.isPlatformAdmin) {
      tasks.push(api<{ items: ApiKeyItem[] }>("/api/v1/platform/api-keys").then((response) => { platformKeys.value = activeApiKeys(response.items); }));
    }
    await Promise.all(tasks);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取 API Key 失败"));
  } finally {
    loading.value = false;
  }
}

async function createKey(type: "personal" | "platform") {
  const name = (type === "personal" ? personalName.value : platformName.value).trim();
  if (!name) return ElMessage.warning(tr("请输入 API Key 名称"));
  if (type === "personal" && personalApprovalMode.value === "never") {
    try {
      await ElMessageBox.confirm(
        tr("完全访问会让持有该 Key 的 Agent 在你的 Viron 权限内直接执行风险操作。凭据输入、账号权限和秘密导出限制仍然保留。"),
        tr("开启远程 MCP 完全访问"),
        { type: "warning", confirmButtonText: tr("确认开启"), cancelButtonText: tr("取消") },
      );
    } catch { return; }
  }
  saving.value = true;
  try {
    revealedKey.value = await api<IssuedApiKey>(type === "personal" ? "/api/v1/api-keys" : "/api/v1/platform/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, ...(type === "personal" ? { mcpApprovalMode: personalApprovalMode.value } : {}) }),
    });
    if (type === "personal") personalName.value = "";
    else platformName.value = "";
    await loadKeys();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建 API Key 失败"));
  } finally {
    saving.value = false;
  }
}

async function updateMcpApprovalMode(item: ApiKeyItem, mode: McpApprovalMode) {
  if (item.type !== "personal" || item.status !== "active" || item.mcpApprovalMode === mode || saving.value) return;
  if (mode === "never") {
    try {
      await ElMessageBox.confirm(
        tr("完全访问会让持有该 Key 的 Agent 在你的 Viron 权限内直接执行风险操作。凭据输入、账号权限和秘密导出限制仍然保留。"),
        tr("开启远程 MCP 完全访问"),
        { type: "warning", confirmButtonText: tr("确认开启"), cancelButtonText: tr("取消") },
      );
    } catch { return; }
  }
  saving.value = true;
  try {
    const updated = await api<ApiKeyItem>(`/api/v1/api-keys/${item.id}/mcp-approval-mode`, {
      method: "PATCH",
      body: JSON.stringify({ mcpApprovalMode: mode }),
    });
    personalKeys.value = personalKeys.value.map((key) => key.id === item.id ? updated : key);
    ElMessage.success(tr("远程 MCP 审批策略已更新"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("更新远程 MCP 审批策略失败"));
  } finally {
    saving.value = false;
  }
}

async function rotateKey(item: ApiKeyItem) {
  try {
    await ElMessageBox.confirm(tr("轮换后旧 Key 会立即失效。新 Key 只展示一次，请先准备好更新调用方配置。"), tr("轮换 {{0}}", [item.name]), {
      type: "warning", confirmButtonText: tr("确认轮换"), cancelButtonText: tr("取消"),
    });
  } catch { return; }
  saving.value = true;
  try {
    const base = item.type === "personal" ? "/api/v1/api-keys" : "/api/v1/platform/api-keys";
    revealedKey.value = await api<IssuedApiKey>(`${base}/${item.id}/rotate`, { method: "POST" });
    await loadKeys();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("轮换 API Key 失败"));
  } finally {
    saving.value = false;
  }
}

async function revokeKey(item: ApiKeyItem) {
  try {
    await ElMessageBox.confirm(tr("撤销后使用该 Key 的服务会立即失去访问权限。"), tr("撤销 {{0}}", [item.name]), {
      type: "warning", confirmButtonText: tr("确认撤销"), cancelButtonText: tr("取消"),
    });
  } catch { return; }
  saving.value = true;
  try {
    const base = item.type === "personal" ? "/api/v1/api-keys" : "/api/v1/platform/api-keys";
    await api(`${base}/${item.id}`, { method: "DELETE" });
    await loadKeys();
    ElMessage.success(tr("API Key 已撤销"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("撤销 API Key 失败"));
  } finally {
    saving.value = false;
  }
}

async function copyRevealedKey() {
  if (!revealedKey.value) return;
  try {
    await copyTextToClipboard(revealedKey.value.apiKey);
    ElMessage.success(tr("API Key 已复制"));
  } catch {
    ElMessage.warning(tr("无法自动复制，请手动选择复制"));
  }
}

onMounted(loadKeys);
</script>

<template>
  <section class="api-key-settings" v-loading="loading">
    <header>
      <span><KeyRound :size="20" /></span>
      <div><h3>API Key</h3><p>{{ $t("个人 Key 继承当前用户权限；平台 Key 可以创建账号和管理组织接入。") }}</p></div>
    </header>

    <article class="key-scope-card">
      <div class="key-scope-heading">
        <span><KeyRound :size="18" /></span>
        <div><strong>{{ $t("个人 API Key") }}</strong><small>{{ $t("用于以你的身份调用 Viron API，也可以换取一次性免密登录票据。") }}</small></div>
      </div>
      <div class="key-create-row">
        <el-input v-model="personalName" maxlength="128" :placeholder='$t("例如：命令行工具")' @keyup.enter="createKey('personal')" />
        <el-button type="primary" :loading="saving" @click="createKey('personal')"><Plus :size="15" />{{ $t("创建个人 Key") }}</el-button>
      </div>
      <div class="personal-mcp-policy">
        <div><strong>{{ $t('新 Key 的远程 MCP 审批策略') }}</strong><small>{{ $t('这是 Viron 的服务端审批层；Codex 客户端仍可独立决定是否在调用 MCP 工具前询问。') }}</small></div>
        <McpApprovalModeSelector v-model="personalApprovalMode" compact :disabled="saving" />
      </div>
      <div class="key-list">
        <div v-if="!personalKeys.length" class="key-empty">{{ $t("尚未创建个人 API Key") }}</div>
        <article v-for="item in personalKeys" :key="item.id" class="key-row key-row--personal">
          <div class="key-row-summary"><div><strong>{{ item.name }}</strong><code>{{ item.keyPrefix }}••••</code><small>{{ $t("最近使用：") }}{{ formatTime(item.lastUsedAt) }}</small></div><em class="is-active">{{ $t("有效") }}</em><div class="key-actions"><el-button :disabled="saving" @click="rotateKey(item)"><RefreshCw :size="14" />{{ $t("轮换") }}</el-button><el-button type="danger" plain :disabled="saving" @click="revokeKey(item)"><Trash2 :size="14" />{{ $t("撤销") }}</el-button></div></div>
          <div class="key-row-policy"><span>{{ $t('远程 MCP') }}</span><McpApprovalModeSelector :model-value="item.mcpApprovalMode" compact :disabled="item.status !== 'active' || saving" @update:model-value="updateMcpApprovalMode(item, $event)" /></div>
        </article>
      </div>
    </article>

    <article v-if="isPlatformAdmin" class="key-scope-card key-scope-card--platform">
      <div class="key-scope-heading">
        <span><ShieldCheck :size="18" /></span>
        <div><strong>{{ $t("平台 API Key") }}</strong><small>{{ $t("仅平台管理员维护。它可以调用账号、组织和项目组供应接口，请只保存在受信任的服务端。") }}</small></div>
      </div>
      <div class="key-create-row">
        <el-input v-model="platformName" maxlength="128" :placeholder='$t("例如：集成服务")' @keyup.enter="createKey('platform')" />
        <el-button type="primary" :loading="saving" @click="createKey('platform')"><Plus :size="15" />{{ $t("创建平台 Key") }}</el-button>
      </div>
      <div class="key-list">
        <div v-if="!platformKeys.length" class="key-empty">{{ $t("尚未创建平台 API Key") }}</div>
        <article v-for="item in platformKeys" :key="item.id" class="key-row">
          <div><strong>{{ item.name }}</strong><code>{{ item.keyPrefix }}••••</code><small>{{ $t("最近使用：") }}{{ formatTime(item.lastUsedAt) }}</small></div>
          <em class="is-active">{{ $t("有效") }}</em>
          <div class="key-actions"><el-button :disabled="saving" @click="rotateKey(item)"><RefreshCw :size="14" />{{ $t("轮换") }}</el-button><el-button type="danger" plain :disabled="saving" @click="revokeKey(item)"><Trash2 :size="14" />{{ $t("撤销") }}</el-button></div>
        </article>
      </div>
    </article>

    <el-dialog :model-value="Boolean(revealedKey)" :title='$t("请立即保存 API Key")' width="min(560px, 92vw)" :close-on-click-modal="false" @close="revealedKey = null">
      <el-alert :title='$t("该 Key 只展示一次。关闭后无法再次查看，只能重新轮换。")' type="warning" :closable="false" show-icon />
      <div v-if="revealedKey" class="revealed-key"><code>{{ revealedKey.apiKey }}</code><el-button @click="copyRevealedKey"><Copy :size="15" />{{ $t("复制") }}</el-button></div>
      <template #footer><el-button @click="revealedKey = null">{{ $t("关闭") }}</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.api-key-settings { width: 100%; display: grid; gap: 14px; }
.api-key-settings > header { padding-bottom: 20px; border-bottom: 1px solid var(--ink-100); display: flex; align-items: center; gap: 12px; }
.api-key-settings > header > span { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 11px 11px 11px 4px; background: var(--teal-50); color: var(--teal-600); display: grid; place-items: center; }
.api-key-settings h3 { margin: 0; color: var(--ink-800); font-size: 20px; }
.api-key-settings header p { margin: 5px 0 0; color: var(--ink-400); font-size: 12px; line-height: 1.55; }
.key-scope-card { padding: 16px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); }
.key-scope-card--platform { border-color: color-mix(in srgb, var(--teal-500) 28%, var(--ink-100)); }
.key-scope-heading { display: flex; align-items: flex-start; gap: 10px; }
.key-scope-heading > span { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 8px; background: var(--teal-50); color: var(--teal-700); display: grid; place-items: center; }
.key-scope-heading strong, .key-scope-heading small { display: block; }
.key-scope-heading strong { color: var(--ink-800); font-size: 13px; }
.key-scope-heading small { margin-top: 4px; color: var(--ink-400); font-size: 11px; line-height: 1.55; }
.key-create-row { margin-top: 14px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.key-list { margin-top: 12px; border-top: 1px solid var(--ink-100); }
.key-empty { padding: 18px 0 4px; color: var(--ink-400); font-size: 12px; text-align: center; }
.key-row { padding: 12px 0; border-bottom: 1px solid var(--ink-100); display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; }
.key-row--personal { display: block; }
.key-row-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; }
.key-row:last-child { border-bottom: 0; }
.key-row strong, .key-row code, .key-row small { display: block; }
.key-row strong { color: var(--ink-700); font-size: 12px; }
.key-row code { margin-top: 4px; color: var(--teal-700); font-family: var(--font-mono); font-size: 10px; }
.key-row small { margin-top: 3px; color: var(--ink-400); font-size: 10px; }
.key-row > em, .key-row-summary > em { padding: 3px 8px; border-radius: 999px; font-size: 10px; font-style: normal; font-weight: 700; }
.key-row > em.is-active, .key-row-summary > em.is-active { background: var(--teal-50); color: var(--teal-700); }
.key-actions { display: flex; gap: 6px; }
.personal-mcp-policy { margin-top: 12px; padding: 12px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--ink-50); display: grid; gap: 10px; }
.personal-mcp-policy strong, .personal-mcp-policy small { display: block; }
.personal-mcp-policy strong { color: var(--ink-700); font-size: 11px; }
.personal-mcp-policy small { margin-top: 3px; color: var(--ink-400); font-size: 9px; line-height: 1.5; }
.key-row-policy { margin-top: 10px; padding: 9px; border-radius: 9px; background: var(--ink-50); display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; gap: 8px; }
.key-row-policy > span { color: var(--ink-400); font-size: 9px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.revealed-key { margin-top: 14px; padding: 10px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--ink-50); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.revealed-key code { overflow-wrap: anywhere; color: var(--ink-800); font-family: var(--font-mono); font-size: 12px; }
@media (max-width: 720px) {
  .key-create-row, .key-row, .key-row-summary, .key-row-policy { grid-template-columns: 1fr; }
  .key-create-row :deep(.el-button) { width: 100%; }
  .key-row > em, .key-row-summary > em { width: max-content; }
  .key-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .revealed-key { grid-template-columns: 1fr; }
}
</style>
