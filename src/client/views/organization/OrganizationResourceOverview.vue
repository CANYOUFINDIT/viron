<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { BookOpen, Boxes, ChevronDown, ChevronLeft, ChevronRight, Layers, Database, FileText, Folder, FolderTree, Globe2, KeyRound, MemoryStick, Search, Server, ShieldCheck, Star, TerminalSquare } from "@lucide/vue";
import { ApiError, api } from "../../api";
import { loadSession } from "../../session";
import { RESOURCE_TYPE_LABELS, RESOURCE_TYPES, type ResourceType } from "../../../shared/organization-rbac";
import { useOrganizationContext } from "./context";
import OperationWindow from "../../components/OperationWindow.vue";
import OrganizationResourceAuthorizationDialog from "./OrganizationResourceAuthorizationDialog.vue";
import RolePermissionList from "./RolePermissionList.vue";
import { pendingResourceGrant } from "./grant-selection";
import {
  authorizationOriginText,
  authorizationStatusText,
  featureSubjectText,
  type SingleTargetGrantEdit,
} from "./authorization-target";

const props = defineProps<{ projectId?: string }>();
const { activePanel, currentOrganizationId } = useOrganizationContext();
const { dataRevision } = useOrganizationContext();
const route = useRoute();
const router = useRouter();
const labels = [
  { id: "environments", label: "环境总览" },
  { id: "credentials", label: "密钥与证书" },
  { id: "ssh", label: "SSH 工作台" },
  { id: "database", label: "数据库工作台" },
  { id: "redis", label: "Redis 工作台" },
  { id: "knowledge", label: "知识库" },
] as const;
type EntryId = (typeof labels)[number]["id"];
type Item = Record<string, any>;
const entries = ref<Array<{ id: EntryId; label: string; count: number; items: Item[]; unlinked?: Item[] }>>(
  labels.map((entry) => ({ ...entry, count: 0, items: [] })),
);
const entryIcons = { environments: Layers, credentials: KeyRound, ssh: TerminalSquare, database: Database, redis: Layers, knowledge: BookOpen };
const selected = ref<EntryId>("environments");
const keyword = ref("");
const draftKeyword = ref("");
function applySearch() { keyword.value = draftKeyword.value; }
const credentialKind = ref<"ssh_key" | "ssl_certificate">("ssh_key");
const error = ref("");
const loading = ref(false);
let loadSequence = 0;
const collapsed = ref(new Set<string>());
const openedEnvironmentId = ref<string | null>(null);
const previewId = ref<string | null>(null);
const grantOpen = ref(false);
const grantTargets = ref<Array<{ type: ResourceType; id: string }>>([]);
const viewOpen = ref(false);
const viewLoading = ref(false);
const viewError = ref("");
const viewDetail = ref<Item | null>(null);
const viewTarget = ref<{ type: ResourceType; id: string } | null>(null);
const editOpen = ref(false);
const editGrant = ref<SingleTargetGrantEdit | null>(null);
const quickOpen = ref(false);
const quickMode = ref<"toggle" | "revoke">("toggle");
const quickRow = ref<Item | null>(null);
const quickReason = ref("");
const quickError = ref("");
const quickStale = ref(false);
const quickSaving = ref(false);
const sectionElements = new Map<string, HTMLElement>();

const current = computed(() => entries.value.find((entry) => entry.id === selected.value) ?? entries.value[0]);
const queryText = computed(() => keyword.value.trim().toLowerCase());
const environments = computed((): Item[] => current.value?.id === "environments" ? current.value.items.filter(matches) : []);
const environmentGroups = computed(() => {
  const items = environments.value;
  const favorites = items.filter((item) => item.favorite);
  const grouped = new Map<string, { id: string; name: string; color: string; items: Item[] }>();
  const ungrouped: Item[] = [];
  for (const item of items) {
    if (!item.groupId) { ungrouped.push(item); continue; }
    const group = grouped.get(item.groupId) ?? { id: item.groupId, name: item.groupName || "环境组", color: item.groupColor || "#1d8a74", items: [] as Item[] };
    group.items.push(item);
    grouped.set(item.groupId, group);
  }
  return [
    { id: "favorites", name: "收藏", color: "#d49a2a", favorite: true, items: favorites },
    ...[...grouped.values()].map((group) => ({ ...group, favorite: false })),
    { id: "ungrouped", name: "未分组", color: "#7d8891", favorite: false, items: ungrouped },
  ];
});
const openedEnvironment = computed(() => environments.value.find((item) => item.id === openedEnvironmentId.value) ?? null);
const unlinked = computed(() => (entries.value[0]?.unlinked ?? []).filter(matches));
const connectionSections = computed(() => {
  const sections = new Map<string, Item[]>();
  for (const item of (current.value?.items ?? []).filter(matches)) {
    const path = item.groupPath || "未分组";
    sections.set(path, [...(sections.get(path) ?? []), item]);
  }
  return [...sections.entries()].map(([path, items]) => ({ path, items }));
});
const credentialItems = computed(() => (entries.value.find((entry) => entry.id === "credentials")?.items ?? []).filter((item) => item.type === credentialKind.value).filter(matches));
const knowledgeItems = computed(() => (entries.value.find((entry) => entry.id === "knowledge")?.items ?? []).filter(matches));
const knowledgeTree = computed(() => {
  const nodes = knowledgeItems.value;
  const children = new Map<string | null, Item[]>();
  for (const node of nodes) {
    const parent = nodes.some((item) => item.id === node.parentId) ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const flat: Array<{ node: Item; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      flat.push({ node, depth });
      if ((node.nodeType ?? node.kind) === "folder") walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return flat;
});
const preview = computed(() => knowledgeItems.value.find((item) => item.id === previewId.value) ?? knowledgeTree.value.find((item) => (item.node.nodeType ?? item.node.kind) !== "folder")?.node ?? null);

function matches(item: Item) {
  if (!queryText.value) return true;
  return [item.name, item.description, item.host, item.username, item.fingerprint, item.engine, item.databaseName, item.groupPath, item.url]
    .some((value) => String(value ?? "").toLowerCase().includes(queryText.value));
}
function setSection(element: Element | null, id: string) {
  if (element) sectionElements.set(id, element as HTMLElement);
  else sectionElements.delete(id);
}
function scrollToGroup(id: string) {
  collapsed.value.delete(id);
  sectionElements.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function toggleGroup(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
async function load() {
  const sequence = ++loadSequence;
  const organizationId = currentOrganizationId.value;
  if (!organizationId) return;
  error.value = "";
  loading.value = true;
  entries.value = labels.map(entry => ({ ...entry, count: 0, items: [] }));
  try {
    const query = props.projectId ? `?projectId=${encodeURIComponent(props.projectId)}` : "";
    const result = await api<{ entries: typeof entries.value }>(`/api/v1/organizations/${organizationId}/resource-overview${query}`);
    if (sequence === loadSequence) entries.value = labels.map(entry => result.entries.find(item => item.id === entry.id) ?? { ...entry, count: 0, items: [] });
  } catch (cause) {
    if (sequence === loadSequence) error.value = cause instanceof Error ? cause.message : "资源总览加载失败";
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

watch(() => [currentOrganizationId.value, props.projectId, dataRevision?.value], load, { immediate: true });
watch(selected, () => {
  draftKeyword.value = "";
  keyword.value = "";
  openedEnvironmentId.value = null;
  previewId.value = null;
});
function resourceRef(item: Item) {
  return item.type && item.id && RESOURCE_TYPES.includes(item.type as ResourceType)
    ? { type: item.type as ResourceType, id: String(item.id) }
    : null;
}
function openMaintain(item: Item) {
  const target = resourceRef(item);
  if (!target || !item.authorization?.maintain) return;
  grantTargets.value = [target];
  grantOpen.value = true;
}
function openRequest(item: Item) {
  const target = resourceRef(item);
  if (!target || !item.authorization?.request) return;
  pendingResourceGrant.value = target;
  activePanel.value = "requests";
  void router.replace({ query: { ...route.query, section: "requests" } });
}
async function reloadView() {
  const target = viewTarget.value;
  const organizationId = currentOrganizationId.value;
  if (!target || !organizationId) return;
  viewLoading.value = true;
  viewError.value = "";
  try {
    viewDetail.value = await api(`/api/v1/organizations/${organizationId}/resource-authorizations/${target.type}/${target.id}`);
  } catch (cause) {
    viewError.value = cause instanceof Error ? cause.message : "授权详情加载失败";
  } finally {
    viewLoading.value = false;
  }
}
async function openView(item: Item) {
  const target = resourceRef(item);
  if (!target || !currentOrganizationId.value || !item.authorization?.view) return;
  viewTarget.value = target;
  viewOpen.value = true;
  viewDetail.value = null;
  await reloadView();
}
function singleFrom(row: Item): SingleTargetGrantEdit | null {
  const target = viewDetail.value?.target;
  if (!target?.type || !target.id || !row?.id || !row.revision) return null;
  return {
    resource: { type: target.type, id: String(target.id), name: target.name },
    kind: row.kind === "feature" ? "feature" : "data",
    id: String(row.id),
    revision: String(row.revision),
    enabled: Boolean(row.enabled),
    startsAt: row.startsAt ?? null,
    expiresAt: row.expiresAt ?? null,
    features: row.features ? { mcp: Boolean(row.features.mcp), agent: Boolean(row.features.agent), webPlugins: Boolean(row.features.webPlugins) } : undefined,
    roleId: row.roleId,
    roleName: row.name,
    permissionCodes: row.permissionCodes ?? [],
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
  };
}
function openEdit(row: Item) {
  if (!row?.canUpdate) return;
  const next = singleFrom(row);
  if (!next) return;
  editGrant.value = next;
  editOpen.value = true;
}
function openQuick(mode: "toggle" | "revoke", row: Item) {
  if (mode === "revoke" ? !row?.canRevoke : !row?.canUpdate) return;
  quickMode.value = mode;
  quickRow.value = row;
  quickReason.value = "";
  quickError.value = "";
  quickStale.value = false;
  quickOpen.value = true;
}
function grantUrl(row: Item) {
  const target = viewTarget.value;
  const organizationId = currentOrganizationId.value;
  if (!target || !organizationId || !row?.id) return "";
  return `/api/v1/organizations/${organizationId}/resource-authorizations/${target.type}/${target.id}/${row.kind === "feature" ? "feature-grants" : "data-grants"}/${row.id}`;
}
async function refreshSurfaces() {
  await Promise.all([load(), reloadView(), loadSession()]);
}
async function refreshEdit() {
  await refreshSurfaces();
  const current = editGrant.value;
  const rows = current?.kind === "feature" ? viewDetail.value?.featureGrants : viewDetail.value?.dataGrants;
  const next = rows?.find((row: Item) => row.id === current?.id);
  if (!next) {
    editOpen.value = false;
    editGrant.value = null;
    ElMessage.warning("这条授权已不在当前资源上，详情已刷新");
    return;
  }
  editGrant.value = singleFrom(next);
}
async function submitQuick() {
  const row = quickRow.value;
  const url = row ? grantUrl(row) : "";
  if (!row || !url || quickSaving.value || quickStale.value || !quickReason.value.trim()) return;
  quickSaving.value = true;
  quickError.value = "";
  try {
    if (quickMode.value === "revoke") {
      await api(url, { method: "DELETE", body: JSON.stringify({ reason: quickReason.value.trim(), revision: row.revision }) });
    } else {
      const body: Record<string, unknown> = {
        enabled: !row.enabled,
        startsAt: row.startsAt ?? null,
        expiresAt: row.expiresAt ?? null,
        reason: quickReason.value.trim(),
        revision: row.revision,
      };
      if (row.kind === "feature") body.features = row.features;
      await api(url, { method: "PUT", body: JSON.stringify(body) });
    }
    quickOpen.value = false;
    await refreshSurfaces();
    ElMessage.success(quickMode.value === "revoke" ? "已撤销当前资源授权" : "已更新当前资源启停");
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) {
      quickStale.value = true;
      quickError.value = cause.message || "当前授权已变更，请刷新后再操作";
      return;
    }
    quickError.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    quickSaving.value = false;
  }
}
async function refreshQuick() {
  quickOpen.value = false;
  quickStale.value = false;
  await refreshSurfaces();
  ElMessage.warning("已刷新当前授权，请重新操作");
}
function featureText(features: Item | undefined) {
  if (!features) return "未选功能";
  return [features.mcp && "MCP", features.agent && "Agent", features.webPlugins && "Web 插件"].filter(Boolean).join("、") || "未选功能";
}
function when(value: string | null | undefined, empty: string) {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
watch(editOpen, (open) => {
  if (!open && viewOpen.value) void refreshSurfaces();
});
async function toggleFavorite(item: Item) {
  try {
    await api(`/api/v1/environments/${item.id}/preferences`, { method: "PUT", body: JSON.stringify({ favorite: !item.favorite }) });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存收藏失败";
  }
}
function endpoint(item: Item) {
  if (!item.host) return "";
  return `${item.username ? `${item.username}@` : ""}${item.host}${item.port ? `:${item.port}` : ""}`;
}
function environmentNames(item: Item) {
  const names = (item.environments ?? []).map((environment: Item) => environment.name).filter(Boolean);
  if (!names.length) return item.environmentIds?.length ? "关联多个环境" : "未关联环境";
  return names.join("、");
}
</script>

<template>
  <section v-loading="loading" class="console-panel organization-resource-browser" aria-label="资源总览">
    <nav class="console-tabs resource-client-tabs lens" aria-label="资源入口">
      <button v-for="entry in entries" :key="entry.id" type="button" :class="{ 'is-active': selected === entry.id }" @click="selected = entry.id">
        <component :is="entryIcons[entry.id]" :size="15" />{{ entry.label }} <small>{{ entry.count }}</small>
      </button>
    </nav>
    <section class="overview-commandbar" :aria-label="current.label">
      <el-input v-model="draftKeyword" clearable :placeholder="selected === 'environments' ? '搜索环境名称、别称或标签' : `搜索${current.label}`" @keyup.enter="applySearch" @clear="keyword = ''">
        <template #prefix><Search :size="16" /></template>
      </el-input>
      <el-button @click="applySearch">应用筛选</el-button>
      <span>{{ queryText ? `找到 ${selected === "environments" ? environments.length : selected === "credentials" ? credentialItems.length : selected === "knowledge" ? knowledgeItems.length : connectionSections.reduce((sum, section) => sum + section.items.length, 0)} 项` : `共 ${current.count} 项` }}</span>
    </section>
    <p v-if="error" class="browser-error">{{ error }}</p>

    <div v-if="selected === 'environments'" class="overview-directory-layout">
      <aside class="environment-directory" aria-label="环境组目录">
        <div class="environment-directory__title"><Boxes :size="16" /><strong>环境目录</strong><small>{{ environments.length }}</small></div>
        <nav>
          <div v-for="group in environmentGroups" :key="group.id" class="environment-directory__item">
            <button class="environment-directory__link" type="button" @click="scrollToGroup(group.id)">
              <span class="group-color" :style="{ background: group.color }"></span>
              <span>{{ group.name }}</span>
              <small>{{ group.items.length }}</small>
            </button>
          </div>
        </nav>
      </aside>
      <main class="environment-sections">
        <section v-for="group in environmentGroups" :key="group.id" :ref="(element) => setSection(element as Element | null, group.id)" class="environment-section" :class="{ 'is-favorites': group.favorite, 'is-collapsed': collapsed.has(group.id) }">
          <header>
            <button class="section-toggle" type="button" :aria-expanded="!collapsed.has(group.id)" @click="toggleGroup(group.id)">
              <ChevronDown :size="16" :class="{ 'is-collapsed': collapsed.has(group.id) }" />
              <span class="group-color" :style="{ background: group.color }"></span>
              <h3>{{ group.name }}</h3>
              <small>{{ group.items.length }} 个环境</small>
            </button>
          </header>
          <template v-if="!collapsed.has(group.id)">
            <div v-if="group.items.length" class="environment-grid">
              <article v-for="item in group.items" :key="`${group.id}-${item.id}`" class="environment-card-shell">
                <div class="environment-card" :class="{ 'is-open': openedEnvironmentId === item.id }" :style="{ '--environment-card-accent': group.favorite ? (item.groupColor || '#1d8a74') : group.color }" @click="openedEnvironmentId = item.id">
                  <div class="environment-browser__chrome">
                    <div class="environment-browser__windowbar">
                      <span class="environment-browser__tab"><i></i><strong :title="item.name">{{ item.name }}</strong><span aria-hidden="true">×</span></span><span class="environment-browser__grip" aria-hidden="true">⠿</span>
                    </div>
                    <div class="environment-browser__toolbar">
                      <ChevronLeft :size="14" class="is-muted" /><ChevronRight :size="14" class="is-muted" />
                      <span class="environment-browser__address"><i></i><strong>{{ item.name }}</strong></span>
                      <button type="button" class="environment-favorite-action" :class="{ 'is-favorite': item.favorite }" :aria-pressed="item.favorite" :aria-label="item.favorite ? `取消收藏 ${item.name}` : `收藏 ${item.name}`" @click.stop="toggleFavorite(item)"><Star :size="13" :fill="item.favorite ? 'currentColor' : 'none'" /></button>
                    </div>
                  </div>
                  <div class="environment-browser__page">
                    <div class="environment-browser__summary">
                      <span class="environment-avatar">{{ String(item.name || '环').slice(0, 2) }}</span>
                      <p class="environment-card__description">{{ item.description || "暂无环境说明" }}</p>
                    </div>
                    <OperationWindow :window="item.operationWindow" @expired="load" />
                    <small v-if="item.partial" class="environment-card__remaining">仅部分连接已授权</small>
                    <div class="resource-counts" aria-label="环境资源数量">
                      <span><Globe2 :size="14" /><strong>{{ item.counts?.web ?? 0 }}</strong><small>Web</small></span>
                      <span><TerminalSquare :size="14" /><strong>{{ item.counts?.ssh ?? 0 }}</strong><small>SSH</small></span>
                      <span><Database :size="14" /><strong>{{ item.counts?.database ?? 0 }}</strong><small>数据库</small></span>
                      <span><MemoryStick :size="14" /><strong>{{ item.counts?.redis ?? 0 }}</strong><small>Redis</small></span>
                    </div>
                    <div class="resource-auth-actions" @click.stop>
                      <el-button v-if="item.authorization?.view" link @click="openView(item)">查看授权</el-button>
                      <el-button v-if="item.authorization?.maintain" type="primary" @click="openMaintain(item)">数据授权</el-button>
                      <el-button v-else-if="item.authorization?.request" link @click="openRequest(item)">申请授权</el-button>
                    </div>
                  </div>
                </div>
              </article>
            </div>
            <div v-else class="environment-group-empty"><Server :size="20" /><span>{{ group.favorite ? (queryText ? "当前筛选下没有收藏环境" : "暂无收藏环境") : (queryText ? "当前筛选下没有环境" : "暂无环境") }}</span></div>
          </template>
        </section>

        <section v-if="openedEnvironment" class="resource-detail" aria-label="环境详情">
          <header><h3>{{ openedEnvironment.name }}</h3><button type="button" @click="openedEnvironmentId = null">返回环境卡片</button></header>
          <div v-for="group in [
            ['Web', openedEnvironment.located?.web ?? []],
            ['日志', openedEnvironment.located?.logs ?? []],
            ['服务 / 脚本 / 监控', openedEnvironment.located?.services ?? []],
            ['知识', openedEnvironment.located?.knowledge ?? []],
          ]" :key="group[0] as string">
            <h4>{{ group[0] }}</h4>
            <p v-if="!(group[1] as Item[]).length" class="browser-empty">此分类暂无资源</p>
            <article v-for="item in (group[1] as Item[])" :key="item.id" class="located-row">
              <div>
                <strong>{{ item.name }}</strong>
                <OperationWindow :window="item.operationWindow" @expired="load" />
                <small>{{ RESOURCE_TYPE_LABELS[item.type as ResourceType] || item.type }}</small>
                <small v-if="item.url">{{ item.url }}</small>
                <p v-if="item.content" class="knowledge-preview">{{ item.content }}</p>
              </div>
              <div class="resource-auth-actions">
                <el-button v-if="item.authorization?.maintain" type="primary" @click="openMaintain(item)">数据授权</el-button>
                <el-button v-else-if="item.authorization?.request" link @click="openRequest(item)">申请授权</el-button>
                <el-button v-if="item.authorization?.view" link @click="openView(item)">查看授权</el-button>
              </div>
            </article>
          </div>
        </section>

        <section class="resource-detail" aria-label="未关联环境的资源">
          <header><h3>未关联环境的资源</h3></header>
          <p v-if="!unlinked.length" class="browser-empty">没有未关联环境的 Web、日志或服务</p>
          <article v-for="item in unlinked" :key="item.id" class="located-row">
            <div><strong>{{ item.name }}</strong><OperationWindow :window="item.operationWindow" @expired="load" /><small>{{ RESOURCE_TYPE_LABELS[item.type as ResourceType] || item.type }}</small><small v-if="item.url">{{ item.url }}</small></div>
            <div class="resource-auth-actions">
              <el-button v-if="item.authorization?.maintain" type="primary" @click="openMaintain(item)">数据授权</el-button>
              <el-button v-else-if="item.authorization?.request" link @click="openRequest(item)">申请授权</el-button>
              <el-button v-if="item.authorization?.view" link @click="openView(item)">查看授权</el-button>
            </div>
          </article>
        </section>
      </main>
    </div>

    <div v-else-if="selected === 'credentials'" class="credential-browser">
      <nav class="vault-tabs" role="tablist">
        <button type="button" :class="{ 'is-active': credentialKind === 'ssh_key' }" @click="credentialKind = 'ssh_key'">SSH 密钥</button>
        <button type="button" :class="{ 'is-active': credentialKind === 'ssl_certificate' }" @click="credentialKind = 'ssl_certificate'">SSL/TLS 证书</button>
      </nav>
      <section class="vault-overview" aria-label="凭据概要">
        <div><span><ShieldCheck :size="15" />组织凭据</span><h2>{{ credentialKind === "ssh_key" ? "密钥与连接引用分开显示" : "证书状态与端点引用" }}</h2><p>未引用的记录仍保留在此目录。引用只展示当前查看人可读的元信息。</p></div>
        <div class="vault-metrics">
          <article><KeyRound :size="18" /><strong>{{ credentialItems.length }}</strong><span>{{ credentialKind === "ssh_key" ? "密钥" : "证书" }}</span></article>
          <article><Server :size="18" /><strong>{{ credentialItems.filter((item) => item.referenced).length }}</strong><span>已引用</span></article>
          <article><KeyRound :size="18" /><strong>{{ credentialItems.filter((item) => !item.referenced).length }}</strong><span>未引用</span></article>
        </div>
      </section>
      <p v-if="!credentialItems.length" class="browser-empty">{{ queryText ? "当前筛选下没有记录" : "暂无数据" }}</p>
      <section v-else class="vault-list">
        <article v-for="item in credentialItems" :key="item.id" class="vault-key-card">
          <div class="vault-key-card__mark"><KeyRound :size="20" /></div>
          <div class="vault-key-card__identity">
            <header><h3>{{ item.name || item.fingerprint }}</h3><span>{{ item.algorithm || (item.referenced ? "已引用" : "未引用") }}</span></header>
            <code>{{ item.fingerprint }}</code>
            <p v-if="item.notAfter">到期 {{ item.notAfter }}</p>
            <ul>
              <li v-for="reference in item.references ?? []" :key="`${reference.id || reference.environmentId}-${reference.host || ''}`">
                {{ reference.name || reference.environmentName || "引用" }}
                <template v-if="reference.host"> · {{ reference.host }}<template v-if="reference.port">:{{ reference.port }}</template></template>
                <template v-else-if="reference.username"> · {{ reference.username }}</template>
                <OperationWindow :window="reference.operationWindow" @expired="load" />
              </li>
            </ul>
            <p v-if="!(item.references ?? []).length">尚未引用</p>
          </div>
        </article>
      </section>
    </div>

    <div v-else-if="selected === 'ssh'" class="ssh-hosts ssh-browse" aria-label="SSH 连接">
      <header><div><strong>SSH 工作台</strong></div></header>
      <div class="ssh-host-list">
        <section v-for="section in connectionSections" :key="section.path" class="workbench-connection-group">
          <button class="workbench-group-toggle" type="button"><FolderTree :size="13" /><span>{{ section.path }}</span><em>{{ section.items.length }}</em></button>
          <div v-for="item in section.items" :key="item.id" class="ssh-host-card">
            <div class="connection-card-main">
              <span class="ssh-host-card__icon"><Server :size="16" /></span>
              <span class="ssh-host-card__details"><strong>{{ item.name }}</strong><OperationWindow :window="item.operationWindow" @expired="load" /><small v-if="endpoint(item)" class="ssh-host-card__endpoint"><span>{{ endpoint(item) }}</span></small></span>
            </div>
            <small class="connection-environments">{{ environmentNames(item) }}</small>
            <div class="resource-auth-actions">
              <el-button v-if="item.authorization?.maintain" type="primary" @click="openMaintain(item)">数据授权</el-button>
              <el-button v-else-if="item.authorization?.request" link @click="openRequest(item)">申请授权</el-button>
              <el-button v-if="item.authorization?.view" link @click="openView(item)">查看授权</el-button>
            </div>
          </div>
        </section>
        <div v-if="!connectionSections.length" class="browser-empty">{{ queryText ? "当前筛选下没有连接" : "暂无 SSH 连接" }}</div>
      </div>
    </div>

    <div v-else-if="selected === 'database'" class="database-navigation-tree" aria-label="数据库连接">
      <section v-for="section in connectionSections" :key="section.path" class="database-navigation-group">
        <button class="database-navigation-group-toggle" type="button"><FolderTree :size="13" /><span>{{ section.path }}</span></button>
        <div v-for="item in section.items" :key="item.id" class="database-navigation-connection-row">
          <span class="database-navigation-placeholder"></span>
          <div class="database-navigation-connection">
            <Database :size="14" />
            <span class="database-navigation-connection-label">{{ item.name }}<template v-if="item.engine"> · {{ item.engine }}</template><template v-if="item.databaseName"> / {{ item.databaseName }}</template><OperationWindow :window="item.operationWindow" @expired="load" /></span>
          </div>
          <small class="connection-environments">{{ environmentNames(item) }}</small>
          <div class="resource-auth-actions">
            <el-button v-if="item.authorization?.maintain" type="primary" @click="openMaintain(item)">数据授权</el-button>
            <el-button v-else-if="item.authorization?.request" link @click="openRequest(item)">申请授权</el-button>
            <el-button v-if="item.authorization?.view" link @click="openView(item)">查看授权</el-button>
          </div>
        </div>
      </section>
      <p v-if="!connectionSections.length" class="browser-empty">{{ queryText ? "当前筛选下没有连接" : "暂无数据库连接" }}</p>
    </div>

    <div v-else-if="selected === 'redis'" class="redis-connection-list" aria-label="Redis 连接">
      <section v-for="section in connectionSections" :key="section.path">
        <h4><FolderTree :size="13" /><span>{{ section.path }}</span><small>{{ section.items.length }}</small></h4>
        <div v-for="item in section.items" :key="item.id" class="redis-row">
          <span class="redis-connection-icon"><MemoryStick :size="14" /></span>
          <div>
            <strong>{{ item.name }}</strong>
            <OperationWindow :window="item.operationWindow" @expired="load" />
            <small v-if="endpoint(item)">{{ endpoint(item) }}</small>
            <small v-if="item.databaseIndex !== undefined">DB {{ item.databaseIndex }}</small>
            <small>{{ environmentNames(item) }}</small>
          </div>
          <div class="resource-auth-actions">
            <el-button v-if="item.authorization?.maintain" type="primary" @click="openMaintain(item)">数据授权</el-button>
            <el-button v-else-if="item.authorization?.request" link @click="openRequest(item)">申请授权</el-button>
            <el-button v-if="item.authorization?.view" link @click="openView(item)">查看授权</el-button>
          </div>
        </div>
      </section>
      <p v-if="!connectionSections.length" class="browser-empty">{{ queryText ? "当前筛选下没有连接" : "暂无 Redis 连接" }}</p>
    </div>

    <div v-else class="knowledge-browser">
      <div class="knowledge-tree" role="tree" aria-label="知识库目录">
        <p v-if="!knowledgeTree.length" class="browser-empty">{{ queryText ? "当前筛选下没有文档" : "暂无知识文档" }}</p>
        <button v-for="item in knowledgeTree" :key="item.node.id" type="button" class="knowledge-tree-row" :class="{ 'is-selected': preview?.id === item.node.id }" :style="{ '--tree-indent': `${item.depth * 15}px` }" @click="previewId = item.node.id">
          <Folder v-if="(item.node.nodeType ?? item.node.kind) === 'folder'" :size="16" />
          <FileText v-else :size="16" />
          <span>{{ item.node.name }}</span>
          <small>{{ environmentNames(item.node) }}</small>
        </button>
      </div>
      <article v-if="preview" class="knowledge-read">
        <header><BookOpen :size="16" /><h3>{{ preview.name }}</h3></header>
        <pre v-if="preview.content">{{ preview.content }}</pre>
        <p v-else>没有正文查看权限，只显示目录。</p>
        <div class="resource-auth-actions">
          <el-button v-if="preview.authorization?.maintain" link type="primary" @click="openMaintain(preview)">数据授权</el-button>
          <el-button v-else-if="preview.authorization?.request" link @click="openRequest(preview)">申请授权</el-button>
          <el-button v-if="preview.authorization?.view" link @click="openView(preview)">查看授权</el-button>
        </div>
      </article>
    </div>

    <OrganizationResourceAuthorizationDialog v-if="grantOpen && currentOrganizationId" v-model="grantOpen" :organization-id="currentOrganizationId" :targets="grantTargets" @saved="refreshSurfaces" />
    <OrganizationResourceAuthorizationDialog v-if="editOpen && editGrant && currentOrganizationId" v-model="editOpen" :organization-id="currentOrganizationId" :single-target="editGrant" @refresh="refreshEdit" />
    <el-dialog v-model="viewOpen" title="查看授权" width="min(760px, calc(100% - 32px))" append-to-body align-center class="envman-dialog">
      <div v-loading="viewLoading">
        <el-alert v-if="viewError" :title="viewError" type="error" :closable="false" />
        <template v-else-if="viewDetail">
          <p class="grant-note">当前目标：{{ viewDetail.target?.name }} · {{ RESOURCE_TYPE_LABELS[viewDetail.target?.type as ResourceType] }}</p>
          <h4>数据授权</h4>
          <article v-for="row in viewDetail.dataGrants" :key="row.id" class="auth-record">
            <header><strong>{{ row.name || "角色" }}</strong><span>{{ authorizationStatusText(row.status) }}</span></header>
            <p>授权来源 {{ authorizationOriginText(row.origin || row.source) }}<template v-if="row.requestId"> · 审批单 {{ row.requestId }}</template> · {{ row.roleEnabled ? "角色启用" : "角色停用" }}</p>
            <p v-if="row.invalidReason">失效原因 {{ row.invalidReason }}</p>
            <p>开始 {{ when(row.startsAt, "立即") }} · 结束 {{ when(row.expiresAt, "永久") }}<template v-if="row.reason"> · 原因 {{ row.reason }}</template></p>
            <RolePermissionList :codes="row.permissionCodes ?? []" />
            <div v-if="row.canUpdate || row.canRevoke" class="auth-record__actions">
              <el-button v-if="row.canUpdate" link type="primary" @click="openEdit(row)">修改</el-button>
              <el-button v-if="row.canUpdate" link @click="openQuick('toggle', row)">{{ row.enabled ? "停用" : "启用" }}</el-button>
              <el-button v-if="row.canRevoke" link type="danger" @click="openQuick('revoke', row)">撤销</el-button>
            </div>
          </article>
          <p v-if="!viewDetail.dataGrants?.length" class="browser-empty">没有数据授权</p>
          <h4>功能授权</h4>
          <article v-for="row in viewDetail.featureGrants" :key="row.id" class="auth-record">
            <header><strong>{{ row.subjectName || "对象" }}</strong><span>{{ authorizationStatusText(row.status) }}</span></header>
            <p>对象来源 {{ featureSubjectText(row.subjectType) }} · {{ row.subjectName || "—" }}</p>
            <p>授权来源 {{ authorizationOriginText(row.origin) }}<template v-if="row.requestId"> · 审批单 {{ row.requestId }}</template> · 功能 {{ featureText(row.features) }}</p>
            <p v-if="row.invalidReason">失效原因 {{ row.invalidReason }}</p>
            <p>开始 {{ when(row.startsAt, "立即") }} · 结束 {{ when(row.expiresAt, "永久") }}<template v-if="row.reason"> · 原因 {{ row.reason }}</template></p>
            <div v-if="row.canUpdate || row.canRevoke" class="auth-record__actions">
              <el-button v-if="row.canUpdate" link type="primary" @click="openEdit(row)">修改</el-button>
              <el-button v-if="row.canUpdate" link @click="openQuick('toggle', row)">{{ row.enabled ? "停用" : "启用" }}</el-button>
              <el-button v-if="row.canRevoke" link type="danger" @click="openQuick('revoke', row)">撤销</el-button>
            </div>
          </article>
          <p v-if="!viewDetail.featureGrants?.length" class="browser-empty">没有功能授权</p>
          <h4>配置维护</h4>
          <article v-for="row in viewDetail.configurationMaintenance ?? []" :key="row.id" class="auth-record">
            <header><strong>{{ row.actorName || "未知操作者" }}</strong><span>配置维护</span></header>
            <p>记录时间 {{ when(row.createdAt, "—") }}</p>
            <RolePermissionList :codes="row.code ? [row.code] : []" />
          </article>
          <p v-if="!(viewDetail.configurationMaintenance ?? []).length" class="browser-empty">没有配置维护记录</p>
        </template>
      </div>
      <template #footer>
        <el-button @click="viewOpen = false">关闭</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="quickOpen" :title="quickMode === 'revoke' ? '撤销当前资源授权' : (quickRow?.enabled ? '停用当前资源授权' : '启用当前资源授权')" width="420px" append-to-body align-center>
      <el-alert v-if="quickError" :title="quickError" type="error" :closable="false" />
      <p class="grant-note">只处理当前查看的资源，原因必填。</p>
      <p v-if="quickRow?.kind !== 'feature'" class="grant-note">会影响该角色所有有效成员在当前资源上的权限；其他资源不变。</p>
      <el-input v-model="quickReason" type="textarea" :rows="3" maxlength="2000" placeholder="填写原因" :disabled="quickStale" />
      <template #footer>
        <el-button @click="quickOpen = false">取消</el-button>
        <el-button v-if="quickStale" type="primary" @click="refreshQuick">刷新授权</el-button>
        <el-button v-else type="primary" :loading="quickSaving" :disabled="!quickReason.trim()" @click="submitQuick">确认</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.organization-resource-browser { min-width: 0; }
.overview-commandbar { display: flex; align-items: center; gap: 12px; padding: 14px 18px 0; }
.overview-commandbar .el-input { max-width: 360px; }
.browser-error { margin: 12px 18px; color: var(--red-500); }
.browser-empty { margin: 8px 0; color: var(--ink-400); font-size: 13px; }
.resource-auth-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 10px; }
.environment-card { cursor: pointer; }
.environment-card.is-open { border-color: var(--teal-500); }
.resource-detail { margin: 8px 0 24px; padding: 14px 16px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--surface); }
.resource-detail header, .located-row, .auth-record header, .knowledge-read header { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.resource-detail h3, .resource-detail h4, .knowledge-read h3 { margin: 0; }
.located-row, .auth-record { padding: 10px 0; border-top: 1px solid var(--ink-100); }
.located-row small, .auth-record p, .grant-note { color: var(--ink-500); font-size: 12px; }
.auth-record__actions { display: flex; gap: 8px; }
.ssh-browse { min-height: 280px; border: 1px solid var(--ink-100); border-radius: 10px; margin: 16px 18px; }
.connection-environments { display: block; padding: 0 8px 6px; color: var(--ink-400); font-size: 11px; }
.credential-browser, .knowledge-browser, .redis-connection-list, .database-navigation-tree { margin: 16px 18px; }
.vault-tabs { display: flex; gap: 16px; margin-bottom: 12px; }
.vault-tabs button { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--ink-500); font-weight: 700; cursor: pointer; }
.vault-tabs button.is-active { border-color: var(--teal-500); color: var(--teal-700); }
.vault-overview { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; padding: 16px; border: 1px solid var(--ink-100); border-radius: 11px; background: var(--surface); }
.vault-overview h2 { margin: 6px 0; font-size: 16px; }
.vault-overview p, .vault-overview span { color: var(--ink-500); font-size: 12px; }
.vault-metrics { display: grid; grid-template-columns: repeat(3, 92px); gap: 8px; }
.vault-metrics article { display: grid; justify-items: center; gap: 4px; padding: 8px; border-left: 1px solid var(--ink-100); }
.vault-list { display: grid; gap: 10px; margin-top: 12px; }
.vault-key-card { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 14px; padding: 16px; border: 1px solid var(--ink-100); border-radius: 11px; background: var(--surface); }
.vault-key-card__mark { width: 44px; height: 44px; border-radius: 11px; background: var(--teal-50); color: var(--teal-700); display: grid; place-items: center; }
.vault-key-card h3 { margin: 0; font-size: 14px; }
.vault-key-card code, .vault-key-card li, .vault-key-card p { color: var(--ink-500); font-size: 12px; }
.vault-key-card ul { margin: 6px 0 0; padding-left: 18px; }
.redis-connection-list section + section { margin-top: 12px; }
.redis-connection-list h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; color: var(--ink-500); font-size: 12px; }
.redis-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 46px; }
.redis-connection-icon { width: 28px; height: 28px; border: 1px solid var(--ink-200); border-radius: 6px; display: grid; place-items: center; }
.redis-row small { display: block; color: var(--ink-500); font-family: var(--font-mono); font-size: 11px; }
.knowledge-browser { display: grid; grid-template-columns: minmax(220px, 320px) minmax(0, 1fr); gap: 16px; min-height: 320px; }
.knowledge-tree { padding: 8px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--surface); overflow: auto; }
.knowledge-tree-row { width: 100%; min-height: 34px; padding-left: calc(8px + var(--tree-indent)); border: 0; background: transparent; display: flex; align-items: center; gap: 6px; text-align: left; cursor: pointer; color: var(--ink-600); }
.knowledge-tree-row.is-selected { background: var(--teal-50); color: var(--teal-700); }
.knowledge-tree-row small { margin-left: auto; color: var(--ink-400); font-size: 11px; }
.knowledge-read { padding: 14px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--surface); }
.knowledge-read pre, .knowledge-preview { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; }
.database-navigation-tree { padding: 8px; border-radius: 10px; }
</style>
