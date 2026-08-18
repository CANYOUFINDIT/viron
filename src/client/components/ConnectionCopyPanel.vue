<script setup lang="ts">import { translate as tr } from "../i18n";

import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, Database, FileText, FolderTree, Globe2, KeyRound, RotateCcw, ShieldCheck, TerminalSquare, Users } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref, type Ref } from "vue";
import { api } from "../api";
import { session } from "../session";
import TipIcon from "./TipIcon.vue";

interface EnvironmentGroupItem { id: string; name: string; description: string; color: string }
interface EnvironmentItem { id: string; groupId: string | null; name: string; description: string; status: string }
interface WebEntryItem { id: string; environmentId: string; name: string; url: string }
interface WebCredentialItem { id: string; webEntryId: string; username: string; note: string }
interface SshItem { id: string; name: string; host: string; port: number; username: string; environmentIds: string[]; jumpConnectionId: string | null; connectionGroupPath: string }
interface DatabaseItem { id: string; name: string; engine: string; host: string; port: number; username: string; environmentIds: string[]; sshConnectionId: string; connectionGroupPath: string }
interface LogItem { id: string; environmentId: string; sshConnectionId: string; name: string; filePaths: string[] }
interface GranteeItem { id: string; name: string; type: "user" | "project" }
interface Catalog {
  environmentGroups: EnvironmentGroupItem[];
  environments: EnvironmentItem[];
  webEntries: WebEntryItem[];
  webCredentials: WebCredentialItem[];
  sshConnections: SshItem[];
  databaseConnections: DatabaseItem[];
  logs: LogItem[];
  grantees: GranteeItem[];
}
interface CopySelection {
  environmentGroupIds: string[];
  environmentIds: string[];
  sshConnectionIds: string[];
  databaseConnectionIds: string[];
  webEntryIds: string[];
  webCredentialIds: string[];
  logIds: string[];
}
interface CopyConflict {
  kind: "environment_group" | "environment" | "ssh_connection" | "database_connection" | "web_entry" | "web_credential" | "environment_log";
  sourceId: string;
  sourceName: string;
  candidates: Array<{ id: string; label: string; context: string }>;
}
interface Preview {
  selection: CopySelection;
  dependencyAdded: Array<{ type: "ssh"; id: string; name: string; reason: string }>;
  conflicts: CopyConflict[];
  secretCount: number;
}
interface CopyResult { counts: Record<string, number>; reused: number }

const loading = ref(false);
const saving = ref(false);
const catalog = ref<Catalog | null>(null);
const step = ref<"select" | "preview" | "complete">("select");
const preview = ref<Preview | null>(null);
const result = ref<CopyResult | null>(null);
const conflictChoices = ref<Record<string, string>>({});
const selectedGrantees = ref<Set<string>>(new Set());
const selectedGroups = ref<Set<string>>(new Set());
const selectedEnvironments = ref<Set<string>>(new Set());
const selectedSsh = ref<Set<string>>(new Set());
const selectedDatabases = ref<Set<string>>(new Set());
const selectedWebEntries = ref<Set<string>>(new Set());
const selectedWebCredentials = ref<Set<string>>(new Set());
const selectedLogs = ref<Set<string>>(new Set());

const canCopy = computed(() => session.workspace?.type === "organization" && session.workspace.role === "admin");
const personalName = computed(() => tr("{0} 的个人空间", [session.user?.username ?? tr("我")]));
const selectionCount = computed(() => [selectedGroups, selectedEnvironments, selectedSsh, selectedDatabases, selectedWebEntries, selectedWebCredentials, selectedLogs]
  .reduce((total, item) => total + item.value.size, 0));
const ungroupedEnvironments = computed(() => catalog.value?.environments.filter((item) => !item.groupId) ?? []);

function updateSet(target: Ref<Set<string>>, id: string, selected: boolean) {
  const next = new Set(target.value);
  if (selected) next.add(id);
  else next.delete(id);
  target.value = next;
}

function entriesForEnvironment(environmentId: string) {
  return catalog.value?.webEntries.filter((item) => item.environmentId === environmentId) ?? [];
}

function credentialsForEntry(entryId: string) {
  return catalog.value?.webCredentials.filter((item) => item.webEntryId === entryId) ?? [];
}

function logsForEnvironment(environmentId: string) {
  return catalog.value?.logs.filter((item) => item.environmentId === environmentId) ?? [];
}

function toggleEnvironment(environmentId: string, selected: boolean) {
  updateSet(selectedEnvironments, environmentId, selected);
  for (const entry of entriesForEnvironment(environmentId)) {
    updateSet(selectedWebEntries, entry.id, selected);
    for (const credential of credentialsForEntry(entry.id)) updateSet(selectedWebCredentials, credential.id, selected);
  }
  for (const log of logsForEnvironment(environmentId)) updateSet(selectedLogs, log.id, selected);
  for (const connection of catalog.value?.sshConnections ?? []) {
    if (!connection.environmentIds.includes(environmentId)) continue;
    const requiredElsewhere = connection.environmentIds.some((id) => id !== environmentId && selectedEnvironments.value.has(id));
    updateSet(selectedSsh, connection.id, selected || requiredElsewhere);
  }
  for (const connection of catalog.value?.databaseConnections ?? []) {
    if (!connection.environmentIds.includes(environmentId)) continue;
    const requiredElsewhere = connection.environmentIds.some((id) => id !== environmentId && selectedEnvironments.value.has(id));
    updateSet(selectedDatabases, connection.id, selected || requiredElsewhere);
  }
}

function toggleGroup(groupId: string, selected: boolean) {
  updateSet(selectedGroups, groupId, selected);
  for (const environment of catalog.value?.environments.filter((item) => item.groupId === groupId) ?? []) toggleEnvironment(environment.id, selected);
}

function toggleEntry(entry: WebEntryItem, selected: boolean) {
  updateSet(selectedWebEntries, entry.id, selected);
  for (const credential of credentialsForEntry(entry.id)) updateSet(selectedWebCredentials, credential.id, selected);
  if (selected) updateSet(selectedEnvironments, entry.environmentId, true);
}

function toggleCredential(credential: WebCredentialItem, selected: boolean) {
  updateSet(selectedWebCredentials, credential.id, selected);
  if (!selected) return;
  const entry = catalog.value?.webEntries.find((item) => item.id === credential.webEntryId);
  if (entry) {
    updateSet(selectedWebEntries, entry.id, true);
    updateSet(selectedEnvironments, entry.environmentId, true);
  }
}

function toggleLog(log: LogItem, selected: boolean) {
  updateSet(selectedLogs, log.id, selected);
  if (selected) {
    updateSet(selectedEnvironments, log.environmentId, true);
    updateSet(selectedSsh, log.sshConnectionId, true);
  }
}

function toggleSsh(id: string, selected: boolean) {
  updateSet(selectedSsh, id, selected);
}

function toggleDatabase(id: string, selected: boolean) {
  updateSet(selectedDatabases, id, selected);
}

function selectAll() {
  if (!catalog.value) return;
  selectedGroups.value = new Set(catalog.value.environmentGroups.map((item) => item.id));
  selectedEnvironments.value = new Set(catalog.value.environments.map((item) => item.id));
  selectedSsh.value = new Set(catalog.value.sshConnections.map((item) => item.id));
  selectedDatabases.value = new Set(catalog.value.databaseConnections.map((item) => item.id));
  selectedWebEntries.value = new Set(catalog.value.webEntries.map((item) => item.id));
  selectedWebCredentials.value = new Set(catalog.value.webCredentials.map((item) => item.id));
  selectedLogs.value = new Set(catalog.value.logs.map((item) => item.id));
}

function clearSelection() {
  selectedGroups.value = new Set();
  selectedEnvironments.value = new Set();
  selectedSsh.value = new Set();
  selectedDatabases.value = new Set();
  selectedWebEntries.value = new Set();
  selectedWebCredentials.value = new Set();
  selectedLogs.value = new Set();
}

function selection(): CopySelection {
  return {
    environmentGroupIds: Array.from(selectedGroups.value), environmentIds: Array.from(selectedEnvironments.value),
    sshConnectionIds: Array.from(selectedSsh.value), databaseConnectionIds: Array.from(selectedDatabases.value),
    webEntryIds: Array.from(selectedWebEntries.value), webCredentialIds: Array.from(selectedWebCredentials.value), logIds: Array.from(selectedLogs.value),
  };
}

function applySelection(value: CopySelection) {
  selectedGroups.value = new Set(value.environmentGroupIds);
  selectedEnvironments.value = new Set(value.environmentIds);
  selectedSsh.value = new Set(value.sshConnectionIds);
  selectedDatabases.value = new Set(value.databaseConnectionIds);
  selectedWebEntries.value = new Set(value.webEntryIds);
  selectedWebCredentials.value = new Set(value.webCredentialIds);
  selectedLogs.value = new Set(value.logIds);
}

async function loadCatalog() {
  if (!canCopy.value) return;
  loading.value = true;
  try {
    catalog.value = await api<Catalog>("/api/v1/connection-copy/catalog");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载个人空间资源失败"));
  } finally {
    loading.value = false;
  }
}

async function createPreview() {
  if (!selectionCount.value) return ElMessage.warning(tr("请至少选择一项个人资源"));
  saving.value = true;
  try {
    preview.value = await api<Preview>("/api/v1/connection-copy/preview", { method: "POST", body: JSON.stringify({ selection: selection() }) });
    applySelection(preview.value.selection);
    conflictChoices.value = Object.fromEntries(preview.value.conflicts.map((item) => [item.sourceId, "new"]));
    step.value = "preview";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("生成复制预览失败"));
  } finally {
    saving.value = false;
  }
}

function granteeKey(item: GranteeItem) {
  return `${item.type}:${item.id}`;
}

function toggleGrantee(item: GranteeItem, selected: boolean) {
  updateSet(selectedGrantees, granteeKey(item), selected);
}

function conflictLabel(kind: CopyConflict["kind"]) {
  return ({ environment_group: tr("环境组"), environment: tr("环境"), ssh_connection: "SSH", database_connection: tr("数据库"), web_entry: tr("Web 入口"), web_credential: tr("Web 账号"), environment_log: tr("日志") })[kind];
}

async function commitCopy() {
  if (!preview.value) return;
  try {
    await ElMessageBox.confirm(tr("将复制 {0} 项配置，其中包含 {1} 份加密凭据。任何一步失败都会全部回滚。", [selectionCount.value, preview.value.secretCount]), tr("确认复制到组织"), { confirmButtonText: tr("开始复制"), cancelButtonText: tr("返回检查"), type: "warning" });
  } catch {
    return;
  }
  saving.value = true;
  try {
    const reuse = Object.fromEntries(Object.entries(conflictChoices.value).filter(([, value]) => value !== "new"));
    const grantees = Array.from(selectedGrantees.value).map((value) => {
      const [type, id] = value.split(":") as ["user" | "project", string];
      return { type, id };
    });
    result.value = await api<CopyResult>("/api/v1/connection-copy", { method: "POST", body: JSON.stringify({ selection: preview.value.selection, reuse, grantees }) });
    step.value = "complete";
    ElMessage.success(tr("个人资源已复制到当前组织"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("复制到组织失败"));
  } finally {
    saving.value = false;
  }
}

function restart() {
  clearSelection();
  selectedGrantees.value = new Set();
  preview.value = null;
  result.value = null;
  step.value = "select";
  void loadCatalog();
}

onMounted(loadCatalog);
</script>

<template>
  <section class="tool-panel copy-tool-panel" v-loading="loading">
    <header class="tool-panel__heading">
      <div><h3>{{ $t('连接复制') }}</h3></div>
      <span v-if="canCopy" class="copy-workspace-target"><Copy :size="15" />{{ personalName }} → {{ session.workspace?.name }}</span>
    </header>

    <div v-if="!canCopy" class="copy-unavailable"><ShieldCheck :size="28" /><h3>{{ $t('仅组织管理员可以复制资源') }}</h3></div>
    <template v-else-if="catalog">
      <nav class="copy-steps"><span :class="{ 'is-active': step === 'select' }"><i>01</i>{{ $t('选择个人资源') }}</span><em></em><span :class="{ 'is-active': step === 'preview' }"><i>02</i>{{ $t('冲突与授权') }}</span><em></em><span :class="{ 'is-active': step === 'complete' }"><i>03</i>{{ $t('完成') }}</span></nav>

      <template v-if="step === 'select'">
        <div class="copy-selection-toolbar"><span>{{ $t('已选择') }} <strong>{{ selectionCount }}</strong> {{ $t('项资源') }}</span><div><el-button size="small" @click="selectAll">{{ $t('全部选择') }}</el-button><el-button size="small" @click="clearSelection">{{ $t('清空') }}</el-button></div></div>
        <section class="copy-resource-section">
          <header><span><FolderTree :size="16" />{{ $t('环境与环境组') }}<TipIcon :content="$t('选择环境时默认包含其中的连接、Web 账号和日志配置。')" placement="right" /></span></header>
          <div class="copy-environment-grid">
            <article v-for="group in catalog.environmentGroups" :key="group.id" class="copy-environment-group">
              <label><el-checkbox :model-value="selectedGroups.has(group.id)" @change="toggleGroup(group.id, Boolean($event))" /><i :style="{ background: group.color }"></i><span><strong>{{ group.name }}</strong><small v-if="group.description">{{ group.description }}</small></span></label>
              <div><label v-for="environment in catalog.environments.filter((item) => item.groupId === group.id)" :key="environment.id"><el-checkbox :model-value="selectedEnvironments.has(environment.id)" @change="toggleEnvironment(environment.id, Boolean($event))" /><span>{{ environment.name }}</span><small>{{ entriesForEnvironment(environment.id).length }} Web · {{ logsForEnvironment(environment.id).length }} {{ $t('日志') }}</small></label></div>
            </article>
            <article v-if="ungroupedEnvironments.length" class="copy-environment-group"><label><FolderTree :size="16" /><span><strong>{{ $t('未分组环境') }}</strong><small>{{ $t('直接位于个人空间') }}</small></span></label><div><label v-for="environment in ungroupedEnvironments" :key="environment.id"><el-checkbox :model-value="selectedEnvironments.has(environment.id)" @change="toggleEnvironment(environment.id, Boolean($event))" /><span>{{ environment.name }}</span><small>{{ entriesForEnvironment(environment.id).length }} Web · {{ logsForEnvironment(environment.id).length }} {{ $t('日志') }}</small></label></div></article>
          </div>
        </section>

        <section class="copy-resource-section">
          <header><span><TerminalSquare :size="16" />{{ $t('连接') }}<TipIcon :content="$t('同一连接关联多个环境时只复制一次。')" placement="right" /></span></header>
          <div class="copy-connection-grid">
            <label v-for="item in catalog.sshConnections" :key="item.id"><el-checkbox :model-value="selectedSsh.has(item.id)" @change="toggleSsh(item.id, Boolean($event))" /><TerminalSquare :size="16" /><span><strong>{{ item.name }}</strong><small>{{ item.username }}@{{ item.host }}:{{ item.port }}</small></span><em>{{ item.connectionGroupPath || $t('未分组') }}</em></label>
            <label v-for="item in catalog.databaseConnections" :key="item.id"><el-checkbox :model-value="selectedDatabases.has(item.id)" @change="toggleDatabase(item.id, Boolean($event))" /><Database :size="16" /><span><strong>{{ item.name }}</strong><small>{{ item.username }}@{{ item.host }}:{{ item.port }}</small></span><em>{{ item.connectionGroupPath || $t('未分组') }}</em></label>
          </div>
        </section>

        <section v-if="catalog.webEntries.length || catalog.logs.length" class="copy-resource-section">
          <header><span><Globe2 :size="16" />{{ $t('Web 账号与日志') }}<TipIcon :content="$t('可取消选择不应进入组织的账号或日志配置。')" placement="right" /></span></header>
          <div class="copy-detail-grid">
            <article v-for="entry in catalog.webEntries" :key="entry.id"><label><el-checkbox :model-value="selectedWebEntries.has(entry.id)" @change="toggleEntry(entry, Boolean($event))" /><Globe2 :size="15" /><span><strong>{{ entry.name }}</strong><small>{{ entry.url }}</small></span></label><div><label v-for="credential in credentialsForEntry(entry.id)" :key="credential.id"><el-checkbox :model-value="selectedWebCredentials.has(credential.id)" @change="toggleCredential(credential, Boolean($event))" /><KeyRound :size="13" />{{ credential.username }}</label></div></article>
            <article v-for="log in catalog.logs" :key="log.id"><label><el-checkbox :model-value="selectedLogs.has(log.id)" @change="toggleLog(log, Boolean($event))" /><FileText :size="15" /><span><strong>{{ log.name }}</strong><small>{{ log.filePaths.join(' · ') }}</small></span></label></article>
          </div>
        </section>
        <footer class="tool-panel__actions"><el-button type="primary" :disabled="!selectionCount" :loading="saving" @click="createPreview">{{ $t('生成复制预览') }}</el-button></footer>
      </template>

      <template v-else-if="step === 'preview' && preview">
        <div v-if="preview.dependencyAdded.length" class="copy-dependency-note"><AlertTriangle :size="17" /><span><strong>{{ $t('已自动补齐') }} {{ preview.dependencyAdded.length }} {{ $t('条依赖连接') }}</strong><small>{{ preview.dependencyAdded.map((item) => `${item.name}（${item.reason}）`).join('；') }}</small></span></div>
        <section class="copy-resource-section">
          <header><span><AlertTriangle :size="16" />{{ $t('冲突处理') }}<TipIcon :content="$t('默认创建独立副本，也可以复用识别到的组织资源。')" placement="right" /></span></header>
          <div v-if="preview.conflicts.length" class="copy-conflict-list"><article v-for="conflict in preview.conflicts" :key="conflict.sourceId"><span><strong>{{ conflict.sourceName }}</strong><small>{{ conflictLabel(conflict.kind) }} {{ $t('· 发现') }} {{ conflict.candidates.length }} {{ $t('个组织候选') }}</small></span><el-select v-model="conflictChoices[conflict.sourceId]"><el-option :label="$t('新建独立副本')" value="new" /><el-option v-for="candidate in conflict.candidates" :key="candidate.id" :label="$t('复用 {0} · {1}', [candidate.label, candidate.context])" :value="candidate.id" /></el-select></article></div>
          <div v-else class="copy-no-conflict"><CheckCircle2 :size="18" />{{ $t('没有发现需要处理的组织资源冲突') }}</div>
        </section>
        <section class="copy-resource-section">
          <header><span><Users :size="16" />{{ $t('组织授权') }}<TipIcon :content="$t('默认不授权；组织管理员始终可以管理复制后的资源。')" placement="right" /></span></header>
          <div v-if="catalog.grantees.length" class="copy-grantee-grid"><label v-for="item in catalog.grantees" :key="granteeKey(item)"><el-checkbox :model-value="selectedGrantees.has(granteeKey(item))" @change="toggleGrantee(item, Boolean($event))" /><Users :size="15" /><span><strong>{{ item.name }}</strong><small>{{ item.type === 'project' ? $t('项目') : $t('组织成员') }}</small></span></label></div>
          <div v-else class="copy-no-conflict">{{ $t('当前组织没有可选的普通成员或项目，复制后仅组织管理员可用') }}</div>
        </section>
        <div class="copy-security-summary"><ShieldCheck :size="19" /><span><strong>{{ selectionCount }} {{ $t('项配置 ·') }} {{ preview.secretCount }} {{ $t('份加密凭据') }}</strong></span><TipIcon :content="$t('密码与私钥只在服务端内存中解密并重新加密；失败时整次操作回滚。')" placement="left" /></div>
        <footer class="tool-panel__actions"><el-button @click="step = 'select'"><ArrowLeft :size="15" />{{ $t('返回选择') }}</el-button><el-button type="primary" :loading="saving" @click="commitCopy">{{ $t('复制到当前组织') }}</el-button></footer>
      </template>

      <div v-else-if="step === 'complete' && result" class="copy-complete"><CheckCircle2 :size="42" /><h3>{{ $t('资源复制完成') }}</h3><p>{{ $t('已创建或复用') }} {{ Object.entries(result.counts).filter(([key]) => key !== 'grants').reduce((sum, [, value]) => sum + value, 0) }} {{ $t('项资源，复用') }} {{ result.reused }} {{ $t('项组织现有资源。') }}</p><el-button type="primary" @click="restart"><RotateCcw :size="15" />{{ $t('继续复制') }}</el-button></div>
    </template>
  </section>
</template>
