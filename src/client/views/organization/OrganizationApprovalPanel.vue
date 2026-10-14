<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ChevronDown, ChevronUp, Download, Plus, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../../api";
import { workspaceCan } from "../../session";
import { RESOURCE_TYPE_LABELS, resourceKey, type ResourceRef, type ResourceType } from "../../../shared/organization-rbac";
import { grantRequestStatusLabel, linkedEnvironmentState, linkedResources as catalogLinkedResources, toggleLinkedEnvironment, toggleResource } from "./grant-selection";
import GrantRequestDetail from "./GrantRequestDetail.vue";
import { useOrganizationContext } from "./context";

interface CatalogItem {
  type: ResourceType;
  id: string;
  name: string;
  environmentIds: string[];
}
interface FlowRole { id: string; name: string; enabled: boolean }
interface FlowNode {
  id: string;
  name: string;
  mode: string;
  approverUserIds: string[];
  approverRoleId: string | null;
  allowSelf: boolean;
  requireComment: boolean;
  allowTransfer?: boolean;
  allowAddSign?: boolean;
  allowRollback?: boolean;
  unsupported?: boolean;
}
interface FlowItem {
  id: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  coverage: number;
  nodes: FlowNode[];
  targets: Array<ResourceRef & { name?: string }>;
}
interface LedgerTarget extends ResourceRef { name: string }
interface LedgerRow {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  reason: string;
  before: unknown;
  after: unknown;
  targets: LedgerTarget[];
  role: string;
  subject: string;
  source: string;
  requestId: string | null;
  grantId: string | null;
  channel: string | null;
  createdAt: string;
}
interface GrantRequestRow {
  id: string;
  kind: "data" | "feature";
  status: string;
  reason: string;
  requesterName: string;
  targets: ResourceRef[];
  createdAt?: string;
}

const typeSections: Array<[ResourceType, string]> = [
  ["ssh_connection", "SSH 连接"],
  ["database_connection", "数据库连接"],
  ["redis_connection", "Redis 连接"],
  ["environment_log", "环境日志"],
  ["knowledge_node", "知识库"],
  ["service", "服务"],
  ["service_deployment", "服务部署"],
  ["service_script", "脚本"],
  ["monitor_host", "主机监控"],
  ["web_entry", "Web 入口"],
  ["environment", "环境"],
];
const modes = [
  ["any", "或签"],
  ["all", "会签"],
  ["sequence", "依次审批"],
  ["cc", "抄送"],
  ["auto_approve", "自动通过"],
  ["auto_reject", "自动拒绝"],
] as const;
const knownModes = new Set<string>(modes.map((item) => item[0]));


const { currentOrganizationId, session } = useOrganizationContext();
const { dataRevision } = useOrganizationContext();
const tab = ref<"flows" | "requests" | "ledger">("flows");
const flows = ref<FlowItem[]>([]);
const catalog = ref<CatalogItem[]>([]);
const unassigned = ref<CatalogItem[]>([]);
const roles = ref<FlowRole[]>([]);
const flowMembers = ref<Array<{ id: string; username: string; status: string }>>([]);
const requests = ref<GrantRequestRow[]>([]);
const ledger = ref<LedgerRow[]>([]);
const error = ref("");
const requestsError = ref("");
const ledgerError = ref("");
const loading = ref(false);
const editorOpen = ref(false);
const saving = ref(false);
const formError = ref("");
const resourceQuery = ref("");
const draftId = ref<string | null>(null);
const draftDefault = ref(false);
const draftLocked = ref(false);
const draftName = ref("");
const draftNodes = ref<FlowNode[]>([]);
const draftTargets = ref<ResourceRef[]>([]);
const selectedLedger = ref<LedgerRow | null>(null);
const requestDetailId = ref("");
const requestDetailOpen = ref(false);
const ledgerQuery = reactive({ action: "", type: "" as "" | ResourceType, actor: "", target: "", from: "", to: "" });

const canMaintain = computed(() => workspaceCan("approval.workflow"));
const canExport = computed(() => workspaceCan("audit.export"));
const environments = computed(() => catalog.value.filter((item) => item.type === "environment"));
const visibleSections = computed(() => {
  const searching = resourceQuery.value.trim().length > 0;
  return typeSections.filter(([type]) => searching || catalog.value.some((item) => item.type === type));
});
const base = computed(() => `/api/v1/organizations/${currentOrganizationId.value}`);

function modeLabel(mode: string) {
  return modes.find((item) => item[0] === mode)?.[1] ?? `不支持的旧模式（${mode}）`;
}
function nodeUnsupported(node: FlowNode) {
  return node.unsupported === true || !knownModes.has(node.mode);
}
function flowLocked(flow: FlowItem) {
  return flow.nodes.some(nodeUnsupported);
}
function catalogItem(target: ResourceRef) {
  return catalog.value.find((item) => resourceKey(item) === resourceKey(target));
}
function targetText(target: ResourceRef & { name?: string }) {
  const name = target.name?.trim() || catalogItem(target)?.name || "";
  const label = RESOURCE_TYPE_LABELS[target.type] ?? target.type;
  return name ? `${label} · ${name}` : `${label} · ${target.id}`;
}
function linkedResources(environmentId: string) {
  return catalogLinkedResources(catalog.value, environmentId);
}
function selectedKeys() {
  return new Set(draftTargets.value.map(resourceKey));
}
function environmentState(environmentId: string) {
  return linkedEnvironmentState(catalog.value, draftTargets.value, environmentId);
}
function toggleEnvironment(environmentId: string, checked: boolean) {
  draftTargets.value = toggleLinkedEnvironment(catalog.value, draftTargets.value, environmentId, checked);
}
function toggleTarget(target: ResourceRef, checked: boolean) {
  draftTargets.value = toggleResource(draftTargets.value, target, checked);
}
function matchesQuery(name: string) {
  const query = resourceQuery.value.trim().toLowerCase();
  return !query || name.toLowerCase().includes(query);
}
function sectionItems(type: ResourceType) {
  return catalog.value.filter((item) => item.type === type && matchesQuery(item.name));
}
function editableNode(node: FlowNode): FlowNode {
  return {
    id: node.id,
    name: node.name,
    mode: node.mode,
    approverUserIds: [...node.approverUserIds],
    approverRoleId: node.approverRoleId,
    allowSelf: node.allowSelf === true,
    requireComment: node.requireComment === true,
    allowTransfer: node.allowTransfer !== false,
    allowAddSign: node.allowAddSign !== false,
    allowRollback: node.allowRollback !== false,
    unsupported: node.unsupported === true,
  };
}
function roleChoices(current: string | null) {
  return roles.value.filter((role) => role.enabled || role.id === current);
}
function memberChoices(selected: string[]) {
  const visible = flowMembers.value.filter((member) => member.status === "active" || selected.includes(member.id));
  const missing = selected
    .filter((id) => !visible.some((member) => member.id === id))
    .map((id) => ({ id, username: "成员已移除", status: "disabled" as const }));
  return [...visible, ...missing];
}
function ledgerTargetText(target: LedgerTarget) {
  const label = RESOURCE_TYPE_LABELS[target.type] ?? target.type;
  return target.name.trim() ? `${label} · ${target.name}` : `${label} · ${target.id}（旧记录未保存名称）`;
}
function openCreate() {
  draftId.value = null;
  draftDefault.value = false;
  draftLocked.value = false;
  draftName.value = "";
  draftNodes.value = [{
    id: crypto.randomUUID(),
    name: "审批",
    mode: "any",
    approverUserIds: [],
    approverRoleId: null,
    allowSelf: false,
    requireComment: false,
    allowTransfer: true,
    allowAddSign: true,
    allowRollback: true,
  }];
  draftTargets.value = [];
  resourceQuery.value = "";
  formError.value = "";
  editorOpen.value = true;
}
function openEdit(flow: FlowItem) {
  draftId.value = flow.id;
  draftDefault.value = flow.isDefault;
  draftLocked.value = flowLocked(flow);
  draftName.value = flow.name;
  draftNodes.value = flow.nodes.map(editableNode);
  draftTargets.value = flow.targets.map((target) => ({ type: target.type, id: target.id }));
  resourceQuery.value = "";
  formError.value = "";
  editorOpen.value = true;
}
function addNode() {
  if (draftLocked.value || draftNodes.value.length >= 30) return;
  draftNodes.value.push({
    id: crypto.randomUUID(),
    name: `审批节点 ${draftNodes.value.length + 1}`,
    mode: "any",
    approverUserIds: [],
    approverRoleId: null,
    allowSelf: false,
    requireComment: false,
    allowTransfer: true,
    allowAddSign: true,
    allowRollback: true,
  });
}
function moveNode(index: number, delta: number) {
  const next = index + delta;
  if (draftLocked.value || next < 0 || next >= draftNodes.value.length) return;
  const nodes = [...draftNodes.value];
  const [node] = nodes.splice(index, 1);
  nodes.splice(next, 0, node);
  draftNodes.value = nodes;
}
function removeNode(index: number) {
  if (draftLocked.value || draftNodes.value.length < 2) return;
  draftNodes.value.splice(index, 1);
}
function nodePayload(node: FlowNode) {
  return {
    id: node.id,
    name: node.name.trim(),
    mode: node.mode,
    approverUserIds: [...new Set(node.approverUserIds)],
    approverRoleId: node.approverRoleId || null,
    allowSelf: node.allowSelf === true,
    requireComment: node.requireComment === true,
    allowTransfer: node.allowTransfer !== false,
    allowAddSign: node.allowAddSign !== false,
    allowRollback: node.allowRollback !== false,
  };
}

async function loadFlows() {
  const response = await api<{ items: FlowItem[]; catalog: CatalogItem[]; unassigned: CatalogItem[]; roles: FlowRole[]; members: Array<{ id: string; username: string; status: string }> }>(`${base.value}/approval-flows`);
  flows.value = response.items;
  catalog.value = response.catalog;
  unassigned.value = response.unassigned;
  roles.value = response.roles;
  flowMembers.value = response.members ?? [];
}
async function loadRequests() {
  requestsError.value = "";
  try {
    requests.value = (await api<{ items: GrantRequestRow[] }>(`${base.value}/grant-requests?view=all`)).items;
  } catch (cause) {
    requests.value = [];
    requestsError.value = cause instanceof Error ? cause.message : "授权申请加载失败";
  }
}
function ledgerPath(exporting = false) {
  const params = new URLSearchParams();
  if (exporting) params.set("export", "1");
  if (ledgerQuery.action.trim()) params.set("action", ledgerQuery.action.trim());
  if (ledgerQuery.type) params.set("type", ledgerQuery.type);
  if (ledgerQuery.actor.trim()) params.set("actor", ledgerQuery.actor.trim());
  if (ledgerQuery.target.trim()) params.set("target", ledgerQuery.target.trim());
  if (ledgerQuery.from) params.set("from", new Date(ledgerQuery.from).toISOString());
  if (ledgerQuery.to) params.set("to", new Date(ledgerQuery.to).toISOString());
  const query = params.toString();
  return `${base.value}/grant-ledger${query ? `?${query}` : ""}`;
}
async function loadLedger() {
  ledgerError.value = "";
  try {
    ledger.value = (await api<{ items: LedgerRow[] }>(ledgerPath())).items;
  } catch (cause) {
    ledger.value = [];
    ledgerError.value = cause instanceof Error ? cause.message : "台账加载失败";
  }
}
async function load() {
  if (!currentOrganizationId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await loadFlows();
  } catch (cause) {
    flows.value = [];
    error.value = cause instanceof Error ? cause.message : "审批流程加载失败";
  } finally {
    loading.value = false;
  }
  await Promise.all([loadRequests(), loadLedger()]);
}
watch(currentOrganizationId, () => void load(), { immediate: true });

async function saveFlow() {
  if (draftLocked.value || saving.value) return;
  formError.value = "";
  const nodes = draftNodes.value.map(nodePayload);
  if (!draftName.value.trim() || nodes.some((node) => !node.name || !knownModes.has(node.mode))) {
    formError.value = "流程名称和每个节点的名称、模式都要完整";
    return;
  }
  if (!draftDefault.value && !draftTargets.value.length) {
    formError.value = "指定流程至少选择一个资源，保存前的固定清单不能为空";
    return;
  }
  saving.value = true;
  try {
    await api(`${base.value}/approval-flows`, {
      method: "POST",
      body: JSON.stringify({
        ...(draftId.value ? { id: draftId.value } : {}),
        name: draftName.value.trim(),
        nodes,
        targets: draftDefault.value ? [] : draftTargets.value,
      }),
    });
    editorOpen.value = false;
    ElMessage.success(draftId.value ? "审批流程已更新" : "指定流程已创建");
    await load();
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}
async function removeFlow(flow: FlowItem) {
  if (flow.isDefault || flowLocked(flow)) return;
  try {
    await ElMessageBox.confirm(`删除「${flow.name}」后，这些资源回到默认流程。已提交的申请仍读取原快照。`, "删除指定流程", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
  } catch {
    return;
  }
  try {
    await api(`${base.value}/approval-flows/${flow.id}`, { method: "DELETE" });
    ElMessage.success("指定流程已删除");
    await load();
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : "删除失败");
  }
}
async function exportLedger() {
  ledgerError.value = "";
  try {
    const data = await api<unknown>(ledgerPath(true));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "grant-ledger.json";
    link.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    ledgerError.value = cause instanceof Error ? cause.message : "导出台账失败";
  }
}
function snapshotText(value: unknown) {
  if (value == null) return "无";
  return JSON.stringify(value, null, 2);
}
function when(value: string) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString() : value;
}
watch(() => dataRevision?.value, () => void load());
</script>

<template>
  <section class="console-panel approval-panel" aria-label="审批与台账" v-loading="loading">
    <header class="organization-page-heading"><div class="organization-eyebrow">{{ session?.workspace?.name }} / 组织工作空间</div><h1>审批与台账</h1><p>维护资源审批流程，处理授权申请，并查看授权变化记录。</p></header>
    <nav class="access-switch" aria-label="审批流程、授权申请、授权台账">
      <button type="button" :class="{ 'is-active': tab === 'flows' }" @click="tab = 'flows'">审批流程</button>
      <button type="button" :class="{ 'is-active': tab === 'requests' }" @click="tab = 'requests'">授权申请</button>
      <button type="button" :class="{ 'is-active': tab === 'ledger' }" @click="tab = 'ledger'">授权台账</button>
    </nav>

    <p v-if="tab === 'flows' && error" class="approval-error">{{ error }}</p>
    <template v-if="tab === 'flows'">
      <div class="access-toolbar">
        <p>默认流程承接尚未划入指定流程的资源。指定流程保存的是当前选中的固定目标，同一资源不能同时属于两条指定流程。</p>
        <el-button v-if="canMaintain" type="primary" @click="openCreate"><Plus :size="15" />新增指定流程</el-button>
      </div>
      <div v-if="flows.length" class="organization-table"><table><thead><tr><th>审批流程</th><th>授权范围</th><th>当前覆盖</th><th>审批节点</th><th>操作</th></tr></thead><tbody>
        <tr v-for="flow in flows" :key="flow.id"><td><strong>{{ flow.name }}</strong><small v-if="!flow.enabled">已停用</small><small v-if="flowLocked(flow)" class="approval-error">包含不支持的旧节点，已保留原配置</small></td><td><span class="organization-status" :class="{ 'is-active': flow.isDefault }">{{ flow.isDefault ? '所有连接 · 默认承接' : '指定连接 / 环境' }}</span><small>{{ flow.isDefault ? '排除已划入其他流程的连接' : '保存时按连接检查唯一归属' }}</small></td><td>{{ flow.coverage }} 个授权目标<details class="approval-targets"><summary>查看范围</summary><ul><li v-for="target in (flow.isDefault ? unassigned : flow.targets)" :key="resourceKey(target)">{{ targetText(target) }}</li><li v-if="flow.isDefault && !unassigned.length">指定流程已覆盖当前全部资源，新的未分配资源由默认流程承接。</li></ul></details></td><td>{{ flow.nodes.map(node => `${node.name} · ${modeLabel(node.mode)}`).join(' → ') || '暂无节点' }}</td><td class="approval-flow-actions"><el-button v-if="canMaintain" link type="primary" @click="openEdit(flow)">{{ flow.isDefault ? '编辑节点' : '编辑' }}</el-button><el-button v-if="canMaintain && !flow.isDefault" link type="danger" :disabled="flowLocked(flow)" @click="removeFlow(flow)">删除</el-button></td></tr>
      </tbody></table></div>
      <p v-if="!flows.length && !error" class="access-empty">还没有审批流程</p>
    </template>

    <template v-else-if="tab === 'requests'">
      <p class="approval-note">这里列出当前有权查看的组织申请。打开同一份详情处理；此页不新建申请。</p>
      <p v-if="requestsError" class="approval-error">{{ requestsError }}</p>
      <div v-else-if="requests.length" class="access-ledger">
        <div class="access-ledger__head approval-request-grid"><span>申请</span><span>类型</span><span>状态</span><span>目标</span></div>
        <button v-for="item in requests" :key="item.id" type="button" class="access-ledger__row approval-request-grid" @click="requestDetailId = item.id; requestDetailOpen = true">
          <span class="access-identity"><strong>{{ item.requesterName || "申请人" }}</strong><small>{{ item.reason }}</small></span>
          <span>{{ item.kind === "data" ? "数据授权" : "功能授权" }}</span>
          <span>{{ grantRequestStatusLabel[item.status] ?? item.status }}</span>
          <span>{{ item.targets.map(targetText).join("、") || "未记录目标" }}</span>
        </button>
      </div>
      <p v-else class="access-empty">暂无授权申请</p>
      <GrantRequestDetail v-if="requestDetailOpen && currentOrganizationId" v-model="requestDetailOpen" :organization-id="currentOrganizationId" :request-id="requestDetailId" @changed="loadRequests" />
    </template>

    <template v-else>
      <form class="approval-filters" @submit.prevent="loadLedger">
        <label>操作 <input v-model="ledgerQuery.action" placeholder="例如：变更资源关联" /></label>
        <label>资源类型
          <select v-model="ledgerQuery.type">
            <option value="">全部</option>
            <option v-for="item in typeSections" :key="item[0]" :value="item[0]">{{ item[1] }}</option>
          </select>
        </label>
        <label>开始 <input v-model="ledgerQuery.from" type="datetime-local" /></label>
        <label>结束 <input v-model="ledgerQuery.to" type="datetime-local" /></label>
        <label>操作者 <input v-model="ledgerQuery.actor" placeholder="姓名或成员 ID" /></label>
        <label>对象 <input v-model="ledgerQuery.target" placeholder="资源、角色或子组织" /></label>
        <button type="submit">查询</button>
        <button v-if="canExport" type="button" @click="exportLedger"><Download :size="14" />导出</button>
      </form>
      <p v-if="ledgerError" class="approval-error">{{ ledgerError }}</p>
      <div v-if="ledger.length" class="access-ledger">
        <div class="access-ledger__head approval-ledger-grid"><span>操作</span><span>操作者</span><span>对象</span><span>时间</span></div>
        <button v-for="row in ledger" :key="row.id" type="button" class="access-ledger__row approval-ledger-grid" @click="selectedLedger = row">
          <span class="access-identity"><strong>{{ row.action }}</strong><small>{{ row.reason }}</small></span>
          <span>{{ row.actorName }}</span>
          <span>{{ row.targets.map(ledgerTargetText).join("、") || row.subject || row.role || "无资源目标" }}</span>
          <time :datetime="row.createdAt">{{ when(row.createdAt) }}</time>
        </button>
      </div>
      <p v-else-if="!ledgerError" class="access-empty">没有符合筛选的台账</p>
    </template>

    <el-dialog v-model="editorOpen" append-to-body class="envman-dialog" :title="draftDefault ? '编辑默认流程节点' : draftId ? '编辑指定流程' : '新增指定流程'" width="min(960px, calc(100vw - 32px))">
      <p v-if="formError" class="approval-error">{{ formError }}</p>
      <p v-if="draftLocked" class="approval-error">此流程保留了不支持的旧节点，只能查看，不能编辑、降级或提交。</p>
      <el-form label-position="top" @submit.prevent="saveFlow">
        <el-form-item label="流程名称"><el-input v-model="draftName" maxlength="160" :disabled="draftLocked" /></el-form-item>
        <section class="approval-nodes">
          <header><strong>审批节点</strong><el-button :disabled="draftLocked || draftNodes.length >= 30" @click="addNode"><Plus :size="14" />增加节点</el-button></header>
          <article v-for="(node, index) in draftNodes" :key="node.id" class="workflow-stage">
            <header>
              <span>{{ index + 1 }}</span>
              <strong>{{ node.name || "未命名节点" }}</strong>
              <button type="button" :disabled="draftLocked || index === 0" aria-label="上移节点" @click="moveNode(index, -1)"><ChevronUp :size="15" /></button>
              <button type="button" :disabled="draftLocked || index === draftNodes.length - 1" aria-label="下移节点" @click="moveNode(index, 1)"><ChevronDown :size="15" /></button>
              <button type="button" :disabled="draftLocked || draftNodes.length < 2" aria-label="删除节点" @click="removeNode(index)"><Trash2 :size="15" /></button>
            </header>
            <p v-if="nodeUnsupported(node)">{{ modeLabel(node.mode) }}。原节点已保留，不能改成其他模式。</p>
            <template v-else>
              <el-form-item label="节点名称"><el-input v-model="node.name" maxlength="160" :disabled="draftLocked" /></el-form-item>
              <el-form-item label="方式">
                <el-select v-model="node.mode" :disabled="draftLocked">
                  <el-option v-for="item in modes" :key="item[0]" :label="item[1]" :value="item[0]" />
                </el-select>
              </el-form-item>
              <el-form-item label="指定成员">
                <el-select v-model="node.approverUserIds" multiple filterable :disabled="draftLocked" placeholder="选择成员">
                  <el-option v-for="member in memberChoices(node.approverUserIds)" :key="member.id" :label="member.username" :value="member.id" :disabled="member.status !== 'active'" />
                </el-select>
              </el-form-item>
              <el-form-item label="指定角色">
                <el-select v-model="node.approverRoleId" clearable filterable :disabled="draftLocked" placeholder="不按角色选择">
                  <el-option v-for="role in roleChoices(node.approverRoleId)" :key="role.id" :label="role.enabled ? role.name : `${role.name}（已停用）`" :value="role.id" />
                </el-select>
              </el-form-item>
              <div class="approval-switches">
                <el-checkbox v-model="node.allowSelf" :disabled="draftLocked">显式允许申请人审批</el-checkbox>
                <el-checkbox v-model="node.requireComment" :disabled="draftLocked">必须填写意见</el-checkbox>
                <el-checkbox v-model="node.allowTransfer" :disabled="draftLocked">允许转交</el-checkbox>
                <el-checkbox v-model="node.allowAddSign" :disabled="draftLocked">允许加签</el-checkbox>
                <el-checkbox v-model="node.allowRollback" :disabled="draftLocked">允许回退</el-checkbox>
              </div>
              <small>未勾选“显式允许申请人审批”时排除申请人。角色在申请提交时固定为当时的合格成员，并保留角色选择依据。</small>
            </template>
          </article>
        </section>
        <section v-if="draftDefault" class="approval-checklist">
          <header><strong>当前实际范围</strong><small>已扣掉指定流程，不能在这里改成指定范围</small></header>
          <ul>
            <li v-for="target in unassigned" :key="resourceKey(target)">{{ targetText(target) }}</li>
            <li v-if="!unassigned.length">当前资源都已划入指定流程。</li>
          </ul>
        </section>
        <section v-else class="approval-scope">
          <header><strong>资源范围</strong><el-input v-model="resourceQuery" clearable placeholder="按资源名称筛选" :disabled="draftLocked" /></header>
          <div class="approval-scope__grid">
            <div>
              <h4>按环境批选当前资源</h4>
              <el-checkbox
                v-for="environment in environments.filter((item) => matchesQuery(item.name))"
                :key="environment.id"
                :model-value="environmentState(environment.id) === 'on'"
                :indeterminate="environmentState(environment.id) === 'partial'"
                :disabled="draftLocked || environmentState(environment.id) === 'empty'"
                @change="toggleEnvironment(environment.id, $event === true)"
              >
                {{ environment.name }}
                <small>{{ environmentState(environment.id) === "empty" ? "没有关联资源，留在默认流程" : `当前 ${linkedResources(environment.id).length} 个资源` }}</small>
              </el-checkbox>
            </div>
            <div>
              <section v-for="section in visibleSections" :key="section[0]">
                <h4>{{ section[1] }}</h4>
                <el-checkbox
                  v-for="item in sectionItems(section[0])"
                  :key="resourceKey(item)"
                  :model-value="selectedKeys().has(resourceKey(item))"
                  :disabled="draftLocked"
                  @change="toggleTarget(item, $event === true)"
                >
                  {{ item.name }}
                  <small v-if="item.type !== 'environment' && !item.environmentIds.length">独立</small>
                </el-checkbox>
                <p v-if="!sectionItems(section[0]).length">没有匹配的{{ section[1] }}</p>
              </section>
            </div>
          </div>
          <div class="approval-checklist">
            <header><strong>保存前的固定范围</strong><small>{{ draftTargets.length }} 个带类型目标，共享资源只保留一次</small></header>
            <ul>
              <li v-for="target in draftTargets" :key="resourceKey(target)">
                {{ targetText(target) }}
                <button type="button" :disabled="draftLocked" @click="toggleTarget(target, false)">移除</button>
              </li>
              <li v-if="!draftTargets.length">还没有选择资源。</li>
            </ul>
          </div>
        </section>
      </el-form>
      <template #footer>
        <el-button @click="editorOpen = false">关闭</el-button>
        <el-button type="primary" :loading="saving" :disabled="draftLocked" @click="saveFlow">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="selectedLedger !== null" append-to-body class="envman-dialog" title="台账详情" width="min(760px, calc(100vw - 32px))" @update:model-value="(open: boolean) => { if (!open) selectedLedger = null; }">
      <dl v-if="selectedLedger" class="access-facts">
        <div><dt>操作</dt><dd>{{ selectedLedger.action }}</dd></div>
        <div><dt>操作者</dt><dd>{{ selectedLedger.actorName }}</dd></div>
        <div><dt>时间</dt><dd>{{ when(selectedLedger.createdAt) }}</dd></div>
        <div><dt>来源</dt><dd>{{ selectedLedger.source || "未记录" }}</dd></div>
        <div><dt>原因</dt><dd>{{ selectedLedger.reason || "未记录" }}</dd></div>
        <div><dt>角色</dt><dd>{{ selectedLedger.role || "无" }}</dd></div>
        <div><dt>对象主体</dt><dd>{{ selectedLedger.subject || "无" }}</dd></div>
        <div><dt>申请</dt><dd class="access-reference">{{ selectedLedger.requestId || "无" }}</dd></div>
        <div><dt>目标</dt><dd>{{ selectedLedger.targets.length ? selectedLedger.targets.map(ledgerTargetText).join("、") : "无资源目标" }}</dd></div>
        <div><dt>变更前</dt><dd><pre class="access-reference">{{ snapshotText(selectedLedger.before) }}</pre></dd></div>
        <div><dt>变更后</dt><dd><pre class="access-reference">{{ snapshotText(selectedLedger.after) }}</pre></dd></div>
      </dl>
      <template #footer>
        <el-button @click="selectedLedger = null">关闭</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped src="./organization-access.css"></style>
<style scoped>
.approval-panel { display: flex; flex-direction: column; gap: 16px; }
.access-switch { margin: 0; }
.access-toolbar { justify-content: space-between; }
.access-toolbar p, .approval-note, .approval-flow-card small, .approval-checklist small, .approval-scope small { color: var(--color-muted); font-size: 12px; line-height: 1.6; }
.approval-error { margin: 0; color: #a33b32; font-size: 12px; line-height: 1.6; }
.approval-flow-card { padding: 16px 0; border-top: 1px solid var(--color-rule); }
.approval-flow-card header, .approval-flow-card footer, .approval-nodes > header, .approval-scope > header, .approval-checklist header { display: flex; align-items: center; gap: 10px; }
.approval-flow-card header em { color: var(--color-accent-strong); font-size: 12px; font-style: normal; }
.approval-flow-card ul, .approval-checklist ul { margin: 8px 0 0; padding: 0; list-style: none; max-height: 220px; overflow: auto; }
.approval-flow-card li, .approval-checklist li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--color-rule); color: var(--color-ink-soft); font-size: 12px; }
.approval-flow-card footer { margin-top: 12px; }
.approval-request-grid { grid-template-columns: minmax(220px, 1.4fr) 90px 90px minmax(180px, 1fr); }
.approval-ledger-grid { grid-template-columns: minmax(220px, 1.3fr) 120px minmax(180px, 1fr) 150px; }
.approval-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
.approval-filters label { display: flex; flex-direction: column; gap: 4px; color: var(--color-muted); font-size: 11px; }
.approval-filters input, .approval-filters select, .approval-filters button { min-height: 32px; border: 1px solid var(--color-rule); border-radius: 6px; background: var(--color-paper); color: var(--color-ink); font: inherit; font-size: 12px; }
.approval-filters input, .approval-filters select { padding: 0 8px; }
.approval-filters button { display: inline-flex; align-items: center; gap: 4px; padding: 0 10px; cursor: pointer; }
.approval-nodes { display: flex; flex-direction: column; gap: 8px; }
.approval-switches { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 8px; }
.approval-scope__grid { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(280px, 1.2fr); gap: 16px; max-height: 420px; overflow: auto; }
.approval-scope h4 { margin: 14px 0 8px; color: var(--color-ink); font-size: 12px; }
.approval-scope :deep(.el-checkbox) { display: flex; height: auto; margin: 0 0 6px; white-space: normal; }
.approval-checklist { margin-top: 16px; }
.approval-checklist button { border: 0; background: transparent; color: var(--color-accent-strong); cursor: pointer; }
.access-facts pre { margin: 0; white-space: pre-wrap; }
@media (max-width: 760px) { .approval-scope__grid, .approval-request-grid, .approval-ledger-grid { grid-template-columns: 1fr; } }
</style>
