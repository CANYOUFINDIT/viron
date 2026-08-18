<script setup lang="ts">import { translate as tr } from "../i18n";

import { ClipboardList, Database, Download, RefreshCw, Search, TerminalSquare, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api";
import { auditDetailSummary } from "../audit-detail";
import { AUDIT_SOURCES, type AuditSource } from "../../shared/audit-source";
import PageHeader from "../components/PageHeader.vue";
import {
  deleteDesktopSshRecording,
  downloadApiFile,
  downloadDesktopSshRecording,
  isDesktopApp,
  listDesktopSshRecordings,
} from "../desktop";
import { session } from "../session";

interface AuditActor { id: string; username: string }

interface AuditEvent {
  id: string;
  actor: AuditActor | null;
  source: AuditSource;
  action: string;
  resourceType: string;
  summary: string;
  details: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

const loading = ref(false);
const desktop = isDesktopApp();
const items = ref<AuditEvent[]>([]);
const activeTab = ref<"events" | "recordings" | "queries">("events");
interface RecordingItem { id: string; actor: AuditActor | null; connectionName: string; host: string; status: string; sizeBytes: number; startedAt: string; endedAt: string | null; closeReason: string; source: "server" | "desktop" }
interface QueryHistoryItem { id: string; actor: AuditActor | null; connectionName: string; database: string; sql: string; status: string; durationMs: number; rowCount: number; error: string; createdAt: string }
interface AuditListResponse<T> { items: T[]; page: number; pageSize: number; hasMore: boolean; retentionDays: number }
const recordings = ref<RecordingItem[]>([]);
const queries = ref<QueryHistoryItem[]>([]);
const actors = ref<AuditActor[]>([]);
const actorUserId = ref("");
const auditSource = ref<AuditSource | "">("");
const keyword = ref("");
const retentionDays = ref(30);
const pages = reactive({ events: 1, recordings: 1, queries: 1 });
const hasMore = reactive({ events: false, recordings: false, queries: false });
const loadingMore = ref<"events" | "recordings" | "queries" | null>(null);
let loadGeneration = 0;
let filterTimer: number | undefined;

function listUrl(path: string, page: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: "100" });
  if (actorUserId.value) params.set("actorUserId", actorUserId.value);
  if (path === "/api/v1/audit-events" && auditSource.value) params.set("source", auditSource.value);
  if (keyword.value.trim()) params.set("q", keyword.value.trim());
  return `${path}?${params}`;
}

function matchesDesktopRecording(item: Omit<RecordingItem, "actor" | "source" | "endedAt"> & { endedAt?: string }): boolean {
  if (actorUserId.value && actorUserId.value !== session.user?.id) return false;
  if (new Date(item.startedAt).getTime() < Date.now() - retentionDays.value * 24 * 60 * 60 * 1000) return false;
  const query = keyword.value.trim().toLocaleLowerCase();
  if (!query) return true;
  return [item.connectionName, item.host, item.status, item.closeReason].some((value) => value.toLocaleLowerCase().includes(query));
}

function mergeRecordings(serverItems: Omit<RecordingItem, "source">[], desktopItems: Awaited<ReturnType<typeof listDesktopSshRecordings>>["items"], append: boolean) {
  const localItems = append ? [] : desktopItems.filter(matchesDesktopRecording).map((item) => ({
    ...item,
    actor: session.user ? { id: session.user.id, username: session.user.username } : null,
    endedAt: item.endedAt ?? null,
    source: "desktop" as const,
  }));
  const current = append ? recordings.value : localItems;
  recordings.value = [...current, ...serverItems.map((item) => ({ ...item, source: "server" as const }))]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function load() {
  const generation = ++loadGeneration;
  loadingMore.value = null;
  loading.value = true;
  try {
    const [actorResponse, eventResponse, recordingResponse, queryResponse, desktopRecordingResponse] = await Promise.all([
      api<{ items: AuditActor[] }>("/api/v1/audit-actors"),
      api<AuditListResponse<AuditEvent>>(listUrl("/api/v1/audit-events", 1)),
      api<AuditListResponse<Omit<RecordingItem, "source">>>(listUrl("/api/v1/ssh-recordings", 1)),
      api<AuditListResponse<QueryHistoryItem>>(listUrl("/api/v1/database-query-history", 1)),
      desktop ? listDesktopSshRecordings() : Promise.resolve({ items: [] }),
    ]);
    if (generation !== loadGeneration) return;
    actors.value = actorResponse.items;
    items.value = eventResponse.items;
    mergeRecordings(recordingResponse.items, desktopRecordingResponse.items, false);
    queries.value = queryResponse.items;
    pages.events = pages.recordings = pages.queries = 1;
    hasMore.events = eventResponse.hasMore;
    hasMore.recordings = recordingResponse.hasMore;
    hasMore.queries = queryResponse.hasMore;
    retentionDays.value = eventResponse.retentionDays;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取审计失败"));
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

async function loadMoreItems() {
  const tab = activeTab.value;
  if (!hasMore[tab] || loadingMore.value) return;
  const generation = loadGeneration;
  const page = pages[tab] + 1;
  loadingMore.value = tab;
  try {
    if (tab === "events") {
      const response = await api<AuditListResponse<AuditEvent>>(listUrl("/api/v1/audit-events", page));
      if (generation !== loadGeneration) return;
      items.value.push(...response.items);
      hasMore.events = response.hasMore;
    } else if (tab === "recordings") {
      const response = await api<AuditListResponse<Omit<RecordingItem, "source">>>(listUrl("/api/v1/ssh-recordings", page));
      if (generation !== loadGeneration) return;
      mergeRecordings(response.items, [], true);
      hasMore.recordings = response.hasMore;
    } else {
      const response = await api<AuditListResponse<QueryHistoryItem>>(listUrl("/api/v1/database-query-history", page));
      if (generation !== loadGeneration) return;
      queries.value.push(...response.items);
      hasMore.queries = response.hasMore;
    }
    pages[tab] = page;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取审计失败"));
  } finally {
    if (generation === loadGeneration) loadingMore.value = null;
  }
}

function scheduleFilter() {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => { void load(); }, 300);
}

function countLabel(count: number, more: boolean): string {
  return `${count}${more ? "+" : ""}`;
}

function auditSourceLabel(source: AuditSource): string {
  return source === "manual" ? "人工操作" : source === "mcp" ? "MCP 操作" : source === "system" ? "系统操作" : "历史未知";
}

function activeLoadedCount(): number {
  if (activeTab.value === "events") return items.value.length;
  if (activeTab.value === "recordings") return recordings.value.length;
  return queries.value.length;
}

async function downloadRecording(recording: RecordingItem) {
  try {
    if (recording.source === "desktop") await downloadDesktopSshRecording(recording.id);
    else await downloadApiFile(`/api/v1/ssh-recordings/${recording.id}/download`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("下载录像失败"));
  }
}

async function deleteRecording(recording: RecordingItem) {
  try {
    await ElMessageBox.confirm(tr("确定删除“{0}”的终端录像吗？", [recording.connectionName]), tr("删除终端录像"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    if (recording.source === "desktop") await deleteDesktopSshRecording(recording.id);
    else await api(`/api/v1/ssh-recordings/${recording.id}`, { method: "DELETE" });
    recordings.value = recordings.value.filter((item) => item.id !== recording.id || item.source !== recording.source);
    ElMessage.success(tr("终端录像已删除"));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除录像失败"));
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function canManageRecording(recording: RecordingItem): boolean {
  return recording.source === "desktop" || recording.actor?.id === session.user?.id;
}

watch([actorUserId, auditSource, keyword], scheduleFilter);
onMounted(load);
onBeforeUnmount(() => window.clearTimeout(filterTimer));
</script>

<template>
  <div class="audit-view">
    <PageHeader :title="$t('操作审计')">
      <template #actions><el-button :aria-label="$t('刷新审计数据')" :loading="loading" @click="load"><RefreshCw :size="16" />{{ $t('刷新数据') }}</el-button></template>
    </PageHeader>

    <section class="audit-filterbar" :class="{ 'has-source': activeTab === 'events' }" :aria-label="$t('审计筛选')">
      <el-select v-model="actorUserId" clearable filterable :placeholder="$t('全部用户')"><el-option v-for="actor in actors" :key="actor.id" :label="actor.username" :value="actor.id" /></el-select>
      <el-select v-if="activeTab === 'events'" v-model="auditSource" clearable :placeholder="$t('全部来源')"><el-option v-for="source in AUDIT_SOURCES" :key="source" :label="$t(auditSourceLabel(source))" :value="source" /></el-select>
      <el-input v-model="keyword" clearable :placeholder="$t(activeTab === 'events' ? '搜索操作摘要、动作或资源' : activeTab === 'recordings' ? '搜索连接、主机或状态' : '搜索连接、数据库或状态')"><template #prefix><Search :size="15" /></template></el-input>
      <small>{{ $t('近 {0} 天', [retentionDays]) }} · {{ $t('已加载 {0} 条', [activeLoadedCount()]) }}</small>
    </section>

    <nav class="audit-tabs" :aria-label="$t('审计数据类型')"><button :class="{ 'is-active': activeTab === 'events' }" @click="activeTab = 'events'"><ClipboardList :size="16" />{{ $t('操作事件') }} <small>{{ countLabel(items.length, hasMore.events) }}</small></button><button :class="{ 'is-active': activeTab === 'recordings' }" @click="activeTab = 'recordings'"><TerminalSquare :size="16" />{{ $t('终端录像') }} <small>{{ countLabel(recordings.length, hasMore.recordings) }}</small></button><button :class="{ 'is-active': activeTab === 'queries' }" @click="activeTab = 'queries'"><Database :size="16" />{{ $t('SQL 历史') }} <small>{{ countLabel(queries.length, hasMore.queries) }}</small></button></nav>

    <section v-if="activeTab === 'events'" class="audit-panel" v-loading="loading">
      <div v-if="items.length" class="audit-list">
        <article v-for="item in items" :key="item.id">
          <span class="audit-icon"><ClipboardList :size="16" /></span>
          <div><header><strong>{{ item.summary }}</strong><code>{{ item.action }}</code></header><small class="audit-event-meta"><span class="audit-source" :class="`is-${item.source}`">{{ $t(auditSourceLabel(item.source)) }}</span><span>{{ $t('成员') }} {{ item.actor?.username || $t('系统/未识别') }}</span><span>{{ item.resourceType }}</span><span v-if="item.ipAddress">{{ item.ipAddress }}</span></small><small v-if="auditDetailSummary(item.details).length" class="audit-detail-summary">{{ auditDetailSummary(item.details).join(' · ') }}</small></div>
          <time>{{ new Date(item.createdAt).toLocaleString($locale()) }}</time>
        </article>
      </div>
      <div v-else class="panel-empty panel-empty--large"><ClipboardList :size="30" /><h3>{{ $t('暂无审计记录') }}</h3></div>
      <footer v-if="hasMore.events" class="audit-load-more"><el-button :loading="loadingMore === 'events'" @click="loadMoreItems">{{ $t('加载更多') }}</el-button></footer>
    </section>
    <section v-else-if="activeTab === 'recordings'" class="audit-panel" v-loading="loading"><div v-if="recordings.length" class="recording-list"><article v-for="recording in recordings" :key="`${recording.source}:${recording.id}`"><span class="audit-icon"><TerminalSquare :size="16" /></span><div><strong>{{ recording.connectionName }}</strong><code>{{ recording.host }}</code><small>{{ $t('成员') }} {{ recording.actor?.username || $t('未知') }} · {{ new Date(recording.startedAt).toLocaleString($locale()) }} · {{ recording.source === 'desktop' ? $t('本机 App') : $t('服务端') }} · {{ recording.closeReason || recording.status }}</small></div><span class="recording-size">{{ formatSize(recording.sizeBytes) }}</span><div v-if="canManageRecording(recording)" class="row-actions"><button :title="$t('下载 asciinema 录像')" @click="downloadRecording(recording)"><Download :size="15" /></button><button class="is-danger" :title="$t('删除录像')" :disabled="recording.status === 'recording'" @click="deleteRecording(recording)"><Trash2 :size="15" /></button></div></article></div><div v-else class="panel-empty panel-empty--large"><TerminalSquare :size="30" /><h3>{{ $t('暂无终端录像') }}</h3></div><footer v-if="hasMore.recordings" class="audit-load-more"><el-button :loading="loadingMore === 'recordings'" @click="loadMoreItems">{{ $t('加载更多') }}</el-button></footer></section>
    <section v-else class="audit-panel" v-loading="loading"><div v-if="queries.length" class="query-history-list"><article v-for="query in queries" :key="query.id"><header><span :class="`is-${query.status}`">{{ query.status }}</span><strong>{{ query.connectionName || $t('已删除连接') }} · {{ query.database || $t('默认库') }}</strong><time>{{ new Date(query.createdAt).toLocaleString($locale()) }}</time></header><code>{{ query.sql }}</code><footer><span>{{ $t('成员') }} {{ query.actor?.username || $t('未知') }}</span><span>{{ query.durationMs }} ms</span><span>{{ query.rowCount }} {{ $t('行') }}</span><em v-if="query.error">{{ query.error }}</em></footer></article></div><div v-else class="panel-empty panel-empty--large"><Database :size="30" /><h3>{{ $t('暂无 SQL 历史') }}</h3></div><footer v-if="hasMore.queries" class="audit-load-more"><el-button :loading="loadingMore === 'queries'" @click="loadMoreItems">{{ $t('加载更多') }}</el-button></footer></section>
  </div>
</template>
