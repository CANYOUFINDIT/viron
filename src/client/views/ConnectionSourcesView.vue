<script setup lang="ts">import { currentLocale, translate as tr } from "../i18n";

import { AlertTriangle, ArrowLeft, CalendarClock, ChevronRight, Code2, FileClock, FolderTree, KeyRound, Pencil, Plus, RefreshCw, Server, ShieldCheck, Trash2, Unplug } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import {
  CONNECTION_SOURCE_SCHEDULE_PRESETS,
  DEFAULT_CONNECTION_SOURCE_SCHEDULE_EXPRESSION,
  connectionSourceScheduleExpressionForPreset,
  cronExpressionError,
  matchConnectionSourceSchedulePreset,
  nextCronRun,
  type ConnectionSourceSchedulePresetId,
} from "../../shared/connection-source-schedule";
import { api } from "../api";
import TipIcon from "../components/TipIcon.vue";

defineProps<{ embedded?: boolean }>();

interface ConnectionSource {
  id: string;
  type: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  remotePaths: string[];
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasConfigPassphrase: boolean;
  scheduleEnabled: boolean;
  scheduleExpression: string | null;
  nextSyncAt: string | null;
  conflictBatchId: string | null;
  conflictCount: number;
  lastSyncedAt: string | null;
  sshCount: number;
  databaseCount: number;
  redisCount: number;
  mappingCount: number;
  script: string;
  conflictStrategy: "overwrite" | "ignore";
}

interface EnvironmentItem { id: string; name: string }
interface MappingItem { id: string; sourcePathPrefix: string; environmentId: string; environmentName: string }
interface SyncSummary { created: number; updated: number; ignored: number; missing: number; total: number; byResource?: Record<string, unknown> }
interface SyncRun { id: string; triggerType: "manual" | "schedule"; status: "running" | "success" | "failed"; conflictStrategy: "overwrite" | "ignore"; startedAt: string; completedAt: string | null; durationMs: number; summary: SyncSummary; errorMessage: string }
interface SyncReportItem { resourceType: string; name: string; context: string; action: "created" | "updated" | "ignored" | "missing"; matches?: number }

const loading = ref(true);
const router = useRouter();
const saving = ref(false);
const syncingId = ref("");
const sources = ref<ConnectionSource[]>([]);
const environments = ref<EnvironmentItem[]>([]);
const sourceDialog = ref(false);
const editingId = ref("");
const mappingDialog = ref(false);
const mappingSource = ref<ConnectionSource | null>(null);
const mappings = ref<MappingItem[]>([]);
const mappingForm = reactive({ sourcePathPrefix: "", environmentId: "" });
const form = reactive({ sourceType: "script_sync" as "script_sync" | "securecrt_sync", name: tr("自动资源同步"), script: "#!/bin/sh\n# 在标准输出中返回 Viron schemaVersion 1 JSON\nprintf '%s\\n' '{\"schemaVersion\":1}'", conflictStrategy: "ignore" as "overwrite" | "ignore", host: "", port: 22, username: "", authType: "password" as "password" | "privateKey", password: "", privateKey: "", passphrase: "", configPassphrase: "", remotePaths: "", scheduleEnabled: false, scheduleExpression: DEFAULT_CONNECTION_SOURCE_SCHEDULE_EXPRESSION, schedulePreset: "every-6h" as ConnectionSourceSchedulePresetId });
const scheduleDialog = ref(false);
const scheduleSource = ref<ConnectionSource | null>(null);
const scheduleForm = reactive({ enabled: false, preset: "every-6h" as ConnectionSourceSchedulePresetId, expression: DEFAULT_CONNECTION_SOURCE_SCHEDULE_EXPRESSION });
const reportDialog = ref(false);
const reportSource = ref<ConnectionSource | null>(null);
const reportRuns = ref<SyncRun[]>([]);
const selectedRun = ref<SyncRun | null>(null);
const reportItems = ref<SyncReportItem[]>([]);
const reportLoading = ref(false);

async function load() {
  loading.value = true;
  try {
    const [sourceResponse, environmentResponse] = await Promise.all([api<{ items: ConnectionSource[] }>("/api/v1/connection-sources"), api<{ items: EnvironmentItem[] }>("/api/v1/environments")]);
    sources.value = sourceResponse.items;
    environments.value = environmentResponse.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载同步来源失败"));
  } finally {
    loading.value = false;
  }
}

function emptySourceForm() {
  return { sourceType: "script_sync" as const, name: tr("自动资源同步"), script: "#!/bin/sh\n# 在标准输出中返回 Viron schemaVersion 1 JSON\nprintf '%s\\n' '{\"schemaVersion\":1}'", conflictStrategy: "ignore" as const, host: "", port: 22, username: "", authType: "password" as const, password: "", privateKey: "", passphrase: "", configPassphrase: "", remotePaths: "", scheduleEnabled: false, scheduleExpression: DEFAULT_CONNECTION_SOURCE_SCHEDULE_EXPRESSION, schedulePreset: "every-6h" as ConnectionSourceSchedulePresetId };
}

function assignScheduleFields(expression: string | null | undefined, enabled: boolean) {
  const schedulePreset = matchConnectionSourceSchedulePreset(expression);
  const scheduleExpression = schedulePreset === "custom"
    ? (expression?.trim() || "")
    : connectionSourceScheduleExpressionForPreset(schedulePreset);
  return { scheduleEnabled: enabled, scheduleExpression, schedulePreset };
}

function onFormPresetChange(preset: string) {
  const value = preset as ConnectionSourceSchedulePresetId;
  form.schedulePreset = value;
  if (value !== "custom") form.scheduleExpression = connectionSourceScheduleExpressionForPreset(value);
}

function onSchedulePresetChange(preset: string) {
  const value = preset as ConnectionSourceSchedulePresetId;
  scheduleForm.preset = value;
  if (value !== "custom") scheduleForm.expression = connectionSourceScheduleExpressionForPreset(value);
}

function scheduleLabel(source: ConnectionSource): string {
  if (!source.scheduleEnabled) return tr("未启用");
  const preset = matchConnectionSourceSchedulePreset(source.scheduleExpression);
  if (preset === "custom") return source.scheduleExpression?.trim() || tr("自定义 Cron");
  return tr(CONNECTION_SOURCE_SCHEDULE_PRESETS.find((item) => item.id === preset)!.label);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(currentLocale());
}

function previewNextRun(expression: string): string {
  const next = nextCronRun(expression);
  return next ? formatDateTime(next.toISOString()) : "";
}

function openSchedule(source: ConnectionSource) {
  const fields = assignScheduleFields(source.scheduleExpression, source.scheduleEnabled);
  scheduleSource.value = source;
  Object.assign(scheduleForm, { enabled: source.scheduleEnabled, preset: fields.schedulePreset, expression: fields.scheduleExpression });
  scheduleDialog.value = true;
}

function openCreate() {
  editingId.value = "";
  Object.assign(form, emptySourceForm());
  sourceDialog.value = true;
}

function openEdit(source: ConnectionSource) {
  editingId.value = source.id;
  Object.assign(form, { sourceType: source.type, name: source.name, script: source.script, conflictStrategy: source.conflictStrategy, host: source.host, port: source.port, username: source.username, authType: source.authType, password: "", privateKey: "", passphrase: "", configPassphrase: "", remotePaths: source.remotePaths.join("\n"), ...assignScheduleFields(source.scheduleExpression, source.scheduleEnabled) });
  sourceDialog.value = true;
}

async function saveSchedule() {
  if (!scheduleSource.value) return;
  if (scheduleForm.enabled) {
    const message = cronExpressionError(scheduleForm.expression);
    if (message) return ElMessage.warning(tr(message));
  }
  saving.value = true;
  try {
    await api(`/api/v1/connection-sources/${scheduleSource.value.id}/schedule`, { method: "PUT", body: JSON.stringify({ scheduleEnabled: scheduleForm.enabled, scheduleExpression: scheduleForm.expression }) });
    scheduleDialog.value = false;
    ElMessage.success(tr("定时同步已更新"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存同步源失败"));
  } finally {
    saving.value = false;
  }
}

async function saveSource() {
  if (!form.name.trim()) return ElMessage.warning(tr("请填写来源名称"));
  if (form.sourceType === "script_sync" && !form.script.trim()) return ElMessage.warning(tr("请填写同步脚本"));
  if (form.sourceType === "securecrt_sync" && (!form.host.trim() || !form.username.trim() || !form.remotePaths.trim())) return ElMessage.warning(tr("请填写来源名称、主机、用户名和远端目录"));
  if (form.scheduleEnabled) {
    const message = cronExpressionError(form.scheduleExpression);
    if (message) return ElMessage.warning(tr(message));
  }
  saving.value = true;
  try {
    const payload = form.sourceType === "script_sync"
      ? { name: form.name, script: form.script, conflictStrategy: form.conflictStrategy, scheduleEnabled: form.scheduleEnabled, scheduleExpression: form.scheduleExpression }
      : { ...form, remotePaths: form.remotePaths.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) };
    const path = editingId.value
      ? `/api/v1/connection-sources/${editingId.value}${form.sourceType === "script_sync" ? "/script" : ""}`
      : `/api/v1/connection-sources/${form.sourceType === "script_sync" ? "script" : "securecrt"}`;
    await api(path, { method: editingId.value ? "PUT" : "POST", body: JSON.stringify(payload) });
    sourceDialog.value = false;
    ElMessage.success(editingId.value ? tr("同步源已更新") : tr("同步源已创建"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存同步源失败"));
  } finally {
    saving.value = false;
  }
}

async function syncSource(source: ConnectionSource) {
  syncingId.value = source.id;
  try {
    const result = await api<{ created: number; updated: number; ignored?: number; missing?: number; deleted?: number; credentialWarnings?: number; conflicts?: number; conflictBatchId?: string | null; runId?: string }>(`/api/v1/connection-sources/${source.id}/sync`, { method: "POST" });
    ElMessage.success(source.type === "script_sync" ? tr("同步完成：新增 {0}，覆盖 {1}，忽略 {2}，空间额外 {3}", [result.created, result.updated, result.ignored ?? 0, result.missing ?? 0]) : tr("同步完成：新增 {0}，更新 {1}，来源删除 {2}", [result.created, result.updated, result.deleted]));
    if (result.credentialWarnings) ElMessage.warning(tr("{0} 个连接的凭据需要补录", [result.credentialWarnings]));
    await load();
    if (source.type === "script_sync") await openReports(source, result.runId);
    else if (result.conflicts && result.conflictBatchId) {
      ElMessage.warning(tr("{0} 个连接已存在，请选择跳过、保留副本或覆盖", [result.conflicts]));
      await router.push({ path: "/connections", query: { importBatch: result.conflictBatchId } });
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("同步失败"));
  } finally {
    syncingId.value = "";
  }
}

async function openReports(source: ConnectionSource, runId?: string) {
  reportSource.value = source;
  reportDialog.value = true;
  reportLoading.value = true;
  try {
    reportRuns.value = (await api<{ items: SyncRun[] }>(`/api/v1/connection-sources/${source.id}/runs`)).items;
    const target = runId ? reportRuns.value.find((item) => item.id === runId) : reportRuns.value[0];
    if (target) await selectRun(target);
    else { selectedRun.value = null; reportItems.value = []; }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载同步报告失败"));
  } finally {
    reportLoading.value = false;
  }
}

async function selectRun(run: SyncRun) {
  selectedRun.value = run;
  const report = await api<SyncRun & { items: SyncReportItem[] }>(`/api/v1/connection-source-runs/${run.id}`);
  reportItems.value = report.items;
}

function actionLabel(action: SyncReportItem["action"]): string {
  return { created: tr("新增"), updated: tr("覆盖"), ignored: tr("忽略"), missing: tr("空间额外") }[action];
}

function actionType(action: SyncReportItem["action"]): "success" | "warning" | "info" | "danger" {
  return { created: "success", updated: "warning", ignored: "info", missing: "danger" }[action] as "success" | "warning" | "info" | "danger";
}

function resourceTypeLabel(type: string): string {
  return {
    environment_group: tr("环境组"), environment: tr("环境"), web_entry: tr("Web 入口"), web_credential: tr("Web 账号"),
    connection_group: tr("连接组"), ssh_key: tr("SSH 密钥"), ssh_connection: tr("SSH 连接"),
    database_connection: tr("数据库连接"), database_profile: tr("数据库配置档"), redis_connection: tr("Redis 连接"), environment_log: tr("环境日志"),
  }[type] ?? type;
}

async function removeSource(source: ConnectionSource) {
  try {
    await ElMessageBox.confirm(tr("删除来源“{0}”后，已导入连接会保留并变为手工连接。", [source.name]), tr("删除连接来源"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/connection-sources/${source.id}`, { method: "DELETE" });
    ElMessage.success(tr("连接来源已删除"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除来源失败"));
  }
}

async function openMappings(source: ConnectionSource) {
  mappingSource.value = source;
  const response = await api<{ items: MappingItem[] }>(`/api/v1/connection-sources/${source.id}/mappings`);
  mappings.value = response.items;
  Object.assign(mappingForm, { sourcePathPrefix: "", environmentId: "" });
  mappingDialog.value = true;
}

async function addMapping() {
  if (!mappingSource.value || !mappingForm.sourcePathPrefix.trim() || !mappingForm.environmentId) return ElMessage.warning(tr("请选择来源目录和目标环境"));
  saving.value = true;
  try {
    await api(`/api/v1/connection-sources/${mappingSource.value.id}/mappings`, { method: "POST", body: JSON.stringify(mappingForm) });
    const response = await api<{ items: MappingItem[] }>(`/api/v1/connection-sources/${mappingSource.value.id}/mappings`);
    mappings.value = response.items;
    Object.assign(mappingForm, { sourcePathPrefix: "", environmentId: "" });
    ElMessage.success(tr("映射已创建，当前待分配连接也已自动归属"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建映射失败"));
  } finally {
    saving.value = false;
  }
}

async function deleteMapping(mapping: MappingItem) {
  if (!mappingSource.value) return;
  await api(`/api/v1/connection-sources/${mappingSource.value.id}/mappings/${mapping.id}`, { method: "DELETE" });
  mappings.value = mappings.value.filter((item) => item.id !== mapping.id);
  await load();
}

onMounted(load);
</script>

<template>
  <div class="source-management" v-loading="loading">
    <RouterLink v-if="!embedded" to="/connections" class="back-link"><ArrowLeft :size="16" />{{ $t('返回连接资源池') }}</RouterLink>
    <section class="content-heading source-heading"><div><h2>{{ $t('连接来源与同步') }}</h2></div><el-button @click="openCreate"><Plus :size="16" />{{ $t('新建同步源') }}</el-button></section>
    <section class="source-grid">
      <article v-for="source in sources" :key="source.id" class="source-card" :class="{ 'is-upload': !['securecrt_sync', 'script_sync'].includes(source.type) }">
        <header class="source-card__header"><span class="source-card__icon"><Code2 v-if="source.type === 'script_sync'" :size="21" /><Server v-else-if="source.type === 'securecrt_sync'" :size="21" /><FolderTree v-else :size="21" /></span><div><h3>{{ source.name }}</h3><span class="source-card__status"><i></i>{{ source.type === 'script_sync' ? $t('脚本同步可用') : source.type === 'securecrt_sync' ? $t('同步源可用') : $t('文件导入记录') }}</span></div><button v-if="['securecrt_sync', 'script_sync'].includes(source.type)" class="source-sync-primary" :disabled="syncingId === source.id" @click="syncSource(source)"><RefreshCw :size="16" :class="{ 'is-spinning': syncingId === source.id }" />{{ syncingId === source.id ? $t('正在同步…') : $t('立即同步') }}</button></header>
        <template v-if="source.type === 'securecrt_sync'">
        <div class="source-card__body">
          <section class="source-config-panel">
            <div class="source-config-row"><span>{{ $t('同步服务器') }}</span><code>{{ source.username }}@{{ source.host }}:{{ source.port }}</code></div>
            <div class="source-config-row is-paths"><span>{{ $t('会话目录') }}</span><div class="source-paths"><span v-for="path in source.remotePaths" :key="path"><FolderTree :size="13" />{{ path }}</span></div></div>
            <div class="source-config-row is-schedule"><span>{{ $t('定时同步') }}</span><button type="button" class="source-schedule-value" :class="{ 'is-enabled': source.scheduleEnabled }" @click="openSchedule(source)"><strong>{{ scheduleLabel(source) }}</strong><small v-if="source.scheduleEnabled">{{ source.nextSyncAt ? $t('下次执行 {0}', [formatDateTime(source.nextSyncAt)]) : $t('等待调度') }}</small><small v-else>{{ $t('点击配置自动执行') }}</small></button></div>
            <div class="source-security"><span><ShieldCheck :size="15" />{{ source.hasPassword || source.hasPrivateKey ? $t('同步凭据已加密') : $t('缺少同步凭据') }}</span><span><KeyRound :size="15" />{{ source.hasConfigPassphrase ? $t('配置口令已保存') : $t('未配置口令') }}</span></div>
          </section>
          <aside class="source-result-panel"><header><span>{{ $t('最近同步结果') }}</span><small>{{ source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString($locale()) : $t('尚未同步') }}</small></header><div class="source-counts"><span><strong>{{ source.sshCount }}</strong><small>{{ $t('SSH 连接') }}</small></span><span><strong>{{ source.databaseCount }}</strong><small>{{ $t('数据库') }}</small></span><span><strong>{{ source.mappingCount }}</strong><small>{{ $t('目录映射') }}</small></span></div><button v-if="source.conflictBatchId && source.conflictCount" class="source-existing" @click="router.push({ path: '/connections', query: { importBatch: source.conflictBatchId } })"><span><AlertTriangle :size="16" /><strong>{{ source.conflictCount }} {{ $t('个连接已存在') }}</strong><small>{{ $t('查看已有连接并批量处理') }}</small></span><ChevronRight :size="17" /></button><div v-else class="source-result-ready"><ShieldCheck :size="16" /><span><strong>{{ $t('无需处理') }}</strong><small>{{ $t('没有待确认的已存在连接') }}</small></span></div></aside>
        </div>
        <footer class="source-card__footer"><div class="source-secondary-actions"><button @click="openMappings(source)"><FolderTree :size="15" />{{ $t('目录映射') }}</button><button @click="openSchedule(source)"><CalendarClock :size="15" />{{ $t('定时同步') }}</button><button @click="openEdit(source)"><Pencil :size="15" />{{ $t('编辑配置') }}</button></div><button class="source-delete" :title="$t('删除同步源')" @click="removeSource(source)"><Trash2 :size="15" /></button></footer>
        </template>
        <template v-else-if="source.type === 'script_sync'">
          <div class="source-card__body">
            <section class="source-config-panel">
              <div class="source-config-row"><span>{{ $t('执行方式') }}</span><code>{{ $t('/bin/sh · 隔离 Runner') }}</code></div>
              <div class="source-config-row"><span>{{ $t('冲突策略') }}</span><strong>{{ source.conflictStrategy === 'overwrite' ? $t('无条件覆盖') : $t('直接忽略') }}</strong></div>
              <div class="source-config-row is-schedule"><span>{{ $t('定时同步') }}</span><button type="button" class="source-schedule-value" :class="{ 'is-enabled': source.scheduleEnabled }" @click="openSchedule(source)"><strong>{{ scheduleLabel(source) }}</strong><small v-if="source.scheduleEnabled">{{ source.nextSyncAt ? $t('下次执行 {0}', [formatDateTime(source.nextSyncAt)]) : $t('等待调度') }}</small><small v-else>{{ $t('点击配置自动执行') }}</small></button></div>
              <div class="source-security"><span><ShieldCheck :size="15" />{{ $t('脚本与凭据加密保存') }}</span><span><Code2 :size="15" />{{ source.script.split('\n').length }} {{ $t('行脚本') }}</span></div>
            </section>
            <aside class="source-result-panel"><header><span>{{ $t('空间中的同步连接') }}</span><small>{{ source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString($locale()) : $t('尚未同步') }}</small></header><div class="source-counts"><span><strong>{{ source.sshCount }}</strong><small>SSH</small></span><span><strong>{{ source.databaseCount }}</strong><small>{{ $t('数据库') }}</small></span><span><strong>{{ source.redisCount }}</strong><small>Redis</small></span></div><button class="source-existing source-report-button" @click="openReports(source)"><span><FileClock :size="16" /><strong>{{ $t('查看同步报告') }}</strong><small>{{ $t('Review 每轮新增、覆盖、忽略和空间额外资源') }}</small></span><ChevronRight :size="17" /></button></aside>
          </div>
          <footer class="source-card__footer"><div class="source-secondary-actions"><button @click="openReports(source)"><FileClock :size="15" />{{ $t('同步报告') }}</button><button @click="openSchedule(source)"><CalendarClock :size="15" />{{ $t('定时同步') }}</button><button @click="openEdit(source)"><Pencil :size="15" />{{ $t('编辑配置') }}</button></div><button class="source-delete" :title="$t('删除同步源')" @click="removeSource(source)"><Trash2 :size="15" /></button></footer>
        </template>
        <div v-else class="source-upload-summary"><span><strong>{{ source.sshCount + source.databaseCount + source.redisCount }}</strong> {{ $t('个已导入连接') }}</span><small>{{ source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString($locale()) : $t('文件导入来源') }}</small></div>
      </article>
      <button v-if="!sources.length" class="source-empty" @click="openCreate"><Server :size="30" /><h3>{{ $t('还没有连接来源') }}</h3><span><Plus :size="15" />{{ $t('创建同步源') }}</span></button>
    </section>

    <el-dialog append-to-body v-model="sourceDialog" align-center class="envman-dialog" :title="editingId ? $t('编辑{0}同步源', [form.sourceType === 'script_sync' ? $t('脚本') : ' SecureCRT']) : $t('新建同步源')" width="760px">
      <el-form label-position="top" class="connection-form">
        <el-form-item v-if="!editingId" :label="$t('同步类型')" class="form-span-2"><el-radio-group v-model="form.sourceType"><el-radio-button label="script_sync">{{ $t('脚本同步') }}</el-radio-button><el-radio-button label="securecrt_sync">SecureCRT</el-radio-button></el-radio-group></el-form-item>
        <el-form-item :label="$t('来源名称')" required :class="{ 'form-span-2': form.sourceType === 'script_sync' }"><el-input v-model="form.name" /></el-form-item>
        <template v-if="form.sourceType === 'securecrt_sync'">
          <el-form-item :label="$t('认证方式')"><el-select v-model="form.authType" style="width:100%"><el-option :label="$t('密码')" value="password" /><el-option :label="$t('私钥')" value="privateKey" /></el-select></el-form-item>
          <el-form-item :label="$t('同步主机')" required><el-input v-model="form.host" /></el-form-item><el-form-item :label="$t('SSH 端口')"><el-input-number v-model="form.port" :min="1" :max="65535" style="width:100%" /></el-form-item>
          <el-form-item :label="$t('SSH 用户名')" required><el-input v-model="form.username" /></el-form-item><el-form-item v-if="form.authType === 'password'" :label="$t('SSH 密码')" :required="!editingId"><el-input v-model="form.password" type="password" show-password :placeholder="editingId ? $t('留空表示保持原密码') : ''" /></el-form-item>
          <el-form-item v-if="form.authType === 'privateKey'" :label="$t('SSH 私钥')" class="form-span-2 form-item--code"><el-input v-model="form.privateKey" type="textarea" :rows="5" :placeholder="editingId ? $t('留空表示保持原私钥') : $t('粘贴 OpenSSH 私钥')" /></el-form-item><el-form-item v-if="form.authType === 'privateKey'" :label="$t('私钥口令')"><el-input v-model="form.passphrase" type="password" show-password /></el-form-item>
          <el-form-item :label="$t('SecureCRT 配置口令')"><el-input v-model="form.configPassphrase" type="password" show-password :placeholder="editingId ? $t('留空表示保持原配置口令') : $t('未设置时留空')" /></el-form-item>
          <el-form-item class="form-span-2 form-item--code" required><template #label><span class="form-label-with-tip">{{ $t('远端会话目录') }}<TipIcon :content="$t('支持多个目录；同步会递归读取 INI/Session，来源删除仅做标记。')" placement="right" /></span></template><el-input v-model="form.remotePaths" type="textarea" :rows="4" :placeholder="$t('每行一个绝对路径或 ~/ 相对路径')" /></el-form-item>
        </template>
        <template v-else>
          <el-form-item class="form-span-2 form-item--code" required><template #label><span class="form-label-with-tip">{{ $t('Shell 脚本') }}<TipIcon :content="$t('脚本在独立隔离 Runner 中通过 /bin/sh 执行，标准输出必须只有一个 schemaVersion 1 JSON 对象。')" placement="right" /></span></template><el-input v-model="form.script" type="textarea" :rows="14" resize="vertical" spellcheck="false" /></el-form-item>
          <el-form-item :label="$t('同名资源策略')"><el-select v-model="form.conflictStrategy" style="width:100%"><el-option :label="$t('直接忽略（推荐）')" value="ignore" /><el-option :label="$t('无条件覆盖')" value="overwrite" /></el-select></el-form-item>
        </template>
        <el-form-item :label="$t('定时同步')"><el-switch v-model="form.scheduleEnabled" inline-prompt :active-text='$t("开")' :inactive-text='$t("关")' /></el-form-item>
        <template v-if="form.scheduleEnabled">
          <el-form-item :label="$t('执行频率')" class="form-span-2"><el-select v-model="form.schedulePreset" style="width:100%" @change="onFormPresetChange"><el-option v-for="preset in CONNECTION_SOURCE_SCHEDULE_PRESETS" :key="preset.id" :label="$t(preset.label)" :value="preset.id" /><el-option :label="$t('自定义 Cron')" value="custom" /></el-select></el-form-item>
          <el-form-item v-if="form.schedulePreset === 'custom'" class="form-span-2"><template #label><span class="form-label-with-tip">{{ $t('Cron 表达式') }}<TipIcon :content="$t('支持五段或六段 Cron，按服务运行时区执行。')" placement="right" /></span></template><el-input v-model="form.scheduleExpression" placeholder="0 */6 * * *" /></el-form-item>
          <p v-if="previewNextRun(form.scheduleExpression)" class="source-schedule-preview">{{ $t('下次执行 {0}', [previewNextRun(form.scheduleExpression)]) }}</p>
        </template>
      </el-form>
      <div class="dialog-tip-row"><span>{{ $t('安全存储') }}</span><TipIcon :content="form.sourceType === 'script_sync' ? $t('脚本文本使用平台主密钥加密；原始输出与明文凭据不会进入同步报告或日志。') : $t('同步密码、私钥和 SecureCRT 配置口令使用平台主密钥加密，不会拼入命令行。')" placement="right" /></div>
      <template #footer><el-button @click="sourceDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveSource">{{ $t('保存同步源') }}</el-button></template>
    </el-dialog>

    <el-dialog append-to-body v-model="scheduleDialog" align-center class="envman-dialog" :title="$t('定时自动同步 · {0}', [scheduleSource?.name || ''])" width="560px">
      <el-form label-position="top" class="connection-form">
        <el-form-item :label="$t('启用定时自动执行')"><el-switch v-model="scheduleForm.enabled" inline-prompt :active-text='$t("开")' :inactive-text='$t("关")' /></el-form-item>
        <template v-if="scheduleForm.enabled">
          <el-form-item :label="$t('执行频率')"><el-select v-model="scheduleForm.preset" style="width:100%" @change="onSchedulePresetChange"><el-option v-for="preset in CONNECTION_SOURCE_SCHEDULE_PRESETS" :key="preset.id" :label="$t(preset.label)" :value="preset.id" /><el-option :label="$t('自定义 Cron')" value="custom" /></el-select></el-form-item>
          <el-form-item v-if="scheduleForm.preset === 'custom'"><template #label><span class="form-label-with-tip">{{ $t('Cron 表达式') }}<TipIcon :content="$t('支持五段或六段 Cron，按服务运行时区执行。')" placement="right" /></span></template><el-input v-model="scheduleForm.expression" placeholder="0 */6 * * *" /></el-form-item>
          <p v-if="previewNextRun(scheduleForm.expression)" class="source-schedule-preview">{{ $t('下次执行 {0}', [previewNextRun(scheduleForm.expression)]) }}</p>
        </template>
      </el-form>
      <div class="dialog-tip-row"><span>{{ $t('服务运行期间按服务时区执行。服务重启后，错过的周期会补跑一轮。') }}</span></div>
      <template #footer><el-button @click="scheduleDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveSchedule">{{ $t('保存') }}</el-button></template>
    </el-dialog>

    <el-dialog append-to-body v-model="reportDialog" align-center class="envman-dialog" :title="$t('同步报告 · {0}', [reportSource?.name || ''])" width="1040px">
      <div class="sync-report-layout" v-loading="reportLoading">
        <aside class="sync-run-list"><button v-for="run in reportRuns" :key="run.id" :class="{ active: selectedRun?.id === run.id }" @click="selectRun(run)"><span><strong>{{ new Date(run.startedAt).toLocaleString($locale()) }}</strong><small>{{ run.triggerType === 'schedule' ? $t('定时执行') : $t('手动执行') }} · {{ run.conflictStrategy === 'overwrite' ? $t('覆盖') : $t('忽略') }}</small></span><el-tag size="small" :type="run.status === 'success' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'">{{ run.status === 'success' ? $t('成功') : run.status === 'failed' ? $t('失败') : $t('执行中') }}</el-tag></button><div v-if="!reportRuns.length" class="panel-empty"><FileClock :size="24" /><p>{{ $t('还没有同步报告') }}</p></div></aside>
        <section class="sync-report-detail">
          <template v-if="selectedRun">
            <div v-if="selectedRun.status === 'success'" class="sync-report-summary"><span><strong>{{ selectedRun.summary.created }}</strong><small>{{ $t('新增') }}</small></span><span><strong>{{ selectedRun.summary.updated }}</strong><small>{{ $t('覆盖') }}</small></span><span><strong>{{ selectedRun.summary.ignored }}</strong><small>{{ $t('忽略') }}</small></span><span><strong>{{ selectedRun.summary.missing }}</strong><small>{{ $t('空间额外') }}</small></span></div>
            <el-alert v-else-if="selectedRun.errorMessage" :title="selectedRun.errorMessage" type="error" :closable="false" show-icon />
            <el-table v-if="reportItems.length" :data="reportItems" max-height="460"><el-table-column :label="$t('资源类型')" width="150"><template #default="scope">{{ resourceTypeLabel(scope.row.resourceType) }}</template></el-table-column><el-table-column prop="name" :label="$t('名称')" min-width="180" /><el-table-column prop="context" :label="$t('位置 / 端点')" min-width="230" show-overflow-tooltip /><el-table-column :label="$t('处理')" width="110"><template #default="scope"><el-tag :type="actionType(scope.row.action)" size="small">{{ actionLabel(scope.row.action) }}</el-tag></template></el-table-column><el-table-column prop="matches" :label="$t('匹配数')" width="80" /></el-table>
            <div v-else-if="selectedRun.status === 'success'" class="panel-empty"><ShieldCheck :size="24" /><p>{{ $t('本轮没有资源差异') }}</p></div>
          </template>
          <div v-else class="panel-empty"><FileClock :size="24" /><p>{{ $t('请选择一轮同步') }}</p></div>
        </section>
      </div>
      <template #footer><el-button @click="reportDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>

    <el-dialog append-to-body v-model="mappingDialog" align-center class="envman-dialog" :title="$t('目录映射 · {0}', [mappingSource?.name || ''])" width="680px">
      <div class="dialog-tip-row"><span>{{ $t('映射规则') }}</span><TipIcon :content="$t('路径前缀匹配的新连接会进入指定环境；已有明确归属不会被覆盖。')" placement="right" /></div>
      <div class="mapping-create"><el-input v-model="mappingForm.sourcePathPrefix" :placeholder="$t('来源目录前缀，例如 /Sessions/生产/app')" /><el-select v-model="mappingForm.environmentId" filterable :placeholder="$t('目标环境')"><el-option v-for="environment in environments" :key="environment.id" :label="environment.name" :value="environment.id" /></el-select><el-button type="primary" :loading="saving" @click="addMapping"><Plus :size="14" />{{ $t('添加') }}</el-button></div>
      <div class="mapping-list"><article v-for="mapping in mappings" :key="mapping.id"><span><FolderTree :size="15" /><code>{{ mapping.sourcePathPrefix }}</code></span><ChevronRight :size="15" /><strong>{{ mapping.environmentName }}</strong><button :title="$t('删除映射')" @click="deleteMapping(mapping)"><Trash2 :size="14" /></button></article><div v-if="!mappings.length" class="panel-empty"><Unplug :size="24" /><p>{{ $t('还没有目录映射') }}</p></div></div>
      <template #footer><el-button @click="mappingDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>
  </div>
</template>
