<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Check, GitBranch, History, Plus, RefreshCw, Send, Settings2, ShieldCheck, Trash2, X } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { api } from "../../api";
import { currentLocale, translate as tr } from "../../i18n";
import type { AccessGovernanceEvent, AccessGrantSnapshot, AccessRequest, ApprovalWorkflow } from "../../../shared/access-governance";
import { CAPABILITY_LABELS, ACTION_LABELS, type Capability } from "../../../shared/access-permissions";
import { useOrganizationContext } from "./context";

const { canManageOrganization, currentOrganizationId, detail, grantDialog, historyGrantId, openAccessRequest, session } = useOrganizationContext();
const tab = ref<"requests" | "history">(historyGrantId.value ? "history" : "requests");
const view = ref<"mine" | "todo" | "reviewed" | "all">("mine");
const status = ref("");
const workflow = ref<ApprovalWorkflow | null>(null);
const requests = ref<AccessRequest[]>([]);
const events = ref<AccessGovernanceEvent[]>([]);
const loading = ref(false);
const loadError = ref("");
const page = ref(1);
const hasMore = ref(false);
const historyAction = ref("");
const selectedRequest = ref<AccessRequest | null>(null);
const requestEvents = ref<AccessGovernanceEvent[]>([]);
const requestDialog = ref(false);
const decisionReason = ref("");
const acting = ref(false);
const selectedEvent = ref<AccessGovernanceEvent | null>(null);
const eventDialog = ref(false);
const workflowDialog = ref(false);
const workflowDraft = ref<ApprovalWorkflow>({ name: "授权申请审批", stages: [] });
const savingWorkflow = ref(false);
let loadSequence = 0;
let detailSequence = 0;
const actions = { requested: "提交申请", approved: "节点通过", rejected: "拒绝申请", withdrawn: "撤回申请", granted: "授权生效", updated: "修改授权", revoked: "撤销授权", expired: "自动到期", imported: "历史导入", workflow_updated: "配置审批流程" } as const;
const statuses = { pending: "待审批", approved: "已通过", rejected: "已拒绝", withdrawn: "已撤回" } as const;
const activeMembers = computed(() => detail.value?.members.filter((member) => member.status === "active") ?? []);
const workflowValid = computed(() => Boolean(workflowDraft.value.name.trim()) && workflowDraft.value.stages.length > 0 && workflowDraft.value.stages.every((stage) => stage.name.trim() && stage.approverIds.length));

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : tr("读取授权中心失败"); }
function formatDate(value: string | null): string { return value ? new Date(value).toLocaleString(currentLocale()) : tr("永久"); }
function stageNames(item: AccessRequest, index: number): string {
  return item.workflow.stages[index]?.approverIds.map((id) => item.approverNames[id] ?? id).join("、") ?? "";
}
function stageStatus(item: AccessRequest, index: number): string {
  if (index < item.stageIndex) return tr("已通过");
  if (index === item.stageIndex) return item.status === "pending" ? tr("处理中") : tr(statuses[item.status]);
  return tr("未开始");
}
function permissionText(permissions: Record<string, string[]>): string {
  return Object.entries(permissions).map(([capability, values]) => `${tr(CAPABILITY_LABELS[capability as Capability] ?? capability)} · ${values.map((value) => tr((ACTION_LABELS[capability as Capability] as Record<string, string> | undefined)?.[value] ?? value)).join(" / ")}`).join("；");
}
function snapshotItemScope(snapshot: AccessGrantSnapshot): string {
  const selected = Object.entries(snapshot.items).filter(([, ids]) => ids.length);
  return selected.length ? selected.map(([key, ids]) => `${tr(CAPABILITY_LABELS[key as Capability] ?? key)} · ${snapshot.itemNames?.[key]?.map((item) => item.name).join('、') || tr('指定 {0} 项', [ids.length])}`).join("；") : tr("全部对象（含以后新增）");
}

async function load() {
  const sequence = ++loadSequence;
  const organizationId = currentOrganizationId.value;
  loading.value = true;
  loadError.value = "";
  try {
    const workflowResult = await api<{ workflow: ApprovalWorkflow | null }>(`/api/v1/organizations/${organizationId}/approval-workflow`);
    const query = new URLSearchParams({ page: String(page.value) });
    if (tab.value === "requests") { query.set("view", view.value); if (status.value) query.set("status", status.value); }
    else { if (historyGrantId.value) query.set("grantId", historyGrantId.value); if (historyAction.value) query.set("action", historyAction.value); }
    const result = await api<{ items: AccessRequest[] | AccessGovernanceEvent[]; hasMore: boolean }>(`/api/v1/organizations/${organizationId}/${tab.value === "requests" ? "access-requests" : "access-history"}?${query}`);
    if (sequence !== loadSequence || currentOrganizationId.value !== organizationId) return;
    workflow.value = workflowResult.workflow;
    if (tab.value === "requests") requests.value = result.items as AccessRequest[];
    else events.value = result.items as AccessGovernanceEvent[];
    hasMore.value = result.hasMore;
  } catch (error) { if (sequence === loadSequence) loadError.value = errorMessage(error); }
  finally { if (sequence === loadSequence) loading.value = false; }
}

async function openRequest(item: AccessRequest) {
  const sequence = ++detailSequence;
  const organizationId = currentOrganizationId.value;
  try {
    const result = await api<{ item: AccessRequest; events: AccessGovernanceEvent[] }>(`/api/v1/organizations/${organizationId}/access-requests/${item.id}`);
    if (sequence !== detailSequence || currentOrganizationId.value !== organizationId) return;
    selectedRequest.value = result.item;
    requestEvents.value = result.events;
    decisionReason.value = "";
    requestDialog.value = true;
  } catch (error) { ElMessage.error(errorMessage(error)); }
}

async function decide(decision: "approve" | "reject" | "withdraw") {
  if (!selectedRequest.value || !decisionReason.value.trim() || acting.value) return;
  acting.value = true;
  const item = selectedRequest.value;
  const organizationId = currentOrganizationId.value;
  try {
    await api(`/api/v1/organizations/${organizationId}/access-requests/${item.id}/${decision === "withdraw" ? "withdraw" : "decisions"}`, {
      method: "POST", body: JSON.stringify({ decision: decision === "withdraw" ? undefined : decision, reason: decisionReason.value.trim() }),
    });
    await openRequest(item);
    await load();
    ElMessage.success(tr(decision === "approve" ? "审批已记录" : decision === "reject" ? "申请已拒绝" : "申请已撤回"));
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { acting.value = false; }
}

function editWorkflow() {
  workflowDraft.value = workflow.value ? { name: workflow.value.name, stages: workflow.value.stages.map((stage) => ({ ...stage, approverIds: [...stage.approverIds] })) } : { name: tr("授权申请审批"), stages: [{ name: tr("组织审批"), mode: "any", approverIds: activeMembers.value.filter((member) => member.role === "admin").map((member) => member.id) }] };
  workflowDialog.value = true;
}
function addStage() { workflowDraft.value.stages.push({ name: tr("审批节点 {0}", [workflowDraft.value.stages.length + 1]), mode: "any", approverIds: [] }); }
function moveStage(index: number, offset: number) {
  const stages = workflowDraft.value.stages;
  const other = index + offset;
  if (other < 0 || other >= stages.length) return;
  [stages[index], stages[other]] = [stages[other]!, stages[index]!];
}
async function saveWorkflow() {
  if (!workflowValid.value || savingWorkflow.value) return;
  savingWorkflow.value = true;
  try {
    await api(`/api/v1/organizations/${currentOrganizationId.value}/approval-workflow`, { method: "PUT", body: JSON.stringify(workflowDraft.value) });
    workflowDialog.value = false;
    await load();
    ElMessage.success(tr("审批流程已保存，仅用于新申请"));
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { savingWorkflow.value = false; }
}
function selectTab(next: "requests" | "history") { tab.value = next; page.value = 1; void load(); }
function nextPage(offset: number) { page.value += offset; void load(); }
function openEvent(event: AccessGovernanceEvent) { selectedEvent.value = event; eventDialog.value = true; }
function clearGrantFilter() { historyGrantId.value = ""; }

watch([view, status, historyAction, historyGrantId], () => { page.value = 1; void load(); });
watch(currentOrganizationId, () => { requestDialog.value = false; eventDialog.value = false; workflowDialog.value = false; requests.value = []; events.value = []; workflow.value = null; page.value = 1; void load(); });
watch(grantDialog, (open, previous) => { if (!open && previous) void load(); });
onMounted(() => { void load(); });
</script>

<template>
  <section class="console-panel access-panel" v-loading="loading">
    <header class="access-heading">
      <div><span class="access-eyebrow">{{ $t('申请 · 审批 · 追溯') }}</span><h3>{{ $t('授权中心') }}</h3><p>{{ workflow ? workflow.name : $t('尚未配置审批流程') }}</p></div>
      <div class="access-heading__actions">
        <el-button v-if="canManageOrganization" @click="editWorkflow"><Settings2 :size="15" />{{ $t('审批流程') }}</el-button>
        <el-button :aria-label="$t('刷新授权中心')" @click="load"><RefreshCw :size="15" /></el-button>
        <el-button type="primary" :disabled="!workflow" @click="openAccessRequest"><Plus :size="15" />{{ $t('申请授权') }}</el-button>
      </div>
    </header>
    <div v-if="!workflow && !loading" class="access-notice"><GitBranch :size="18" /><span>{{ $t('组织管理员配置审批节点后，成员即可提交权限申请。') }}</span></div>
    <div class="access-toolbar">
      <div class="access-switch" role="tablist" :aria-label="$t('授权中心视图')">
        <button type="button" role="tab" :aria-selected="tab === 'requests'" :class="{ 'is-active': tab === 'requests' }" @click="selectTab('requests')"><Send :size="14" />{{ $t('授权申请') }}</button>
        <button v-if="canManageOrganization" type="button" role="tab" :aria-selected="tab === 'history'" :class="{ 'is-active': tab === 'history' }" @click="selectTab('history')"><History :size="14" />{{ $t('授权台账') }}</button>
      </div>
      <template v-if="tab === 'requests'">
        <el-select v-model="view" :aria-label="$t('申请范围')"><el-option :label="$t('我的申请')" value="mine" /><el-option :label="$t('待我审批')" value="todo" /><el-option :label="$t('我已审批')" value="reviewed" /><el-option v-if="canManageOrganization" :label="$t('全部申请')" value="all" /></el-select>
        <el-select v-model="status" :empty-values="[null, undefined]" :aria-label="$t('申请状态')"><el-option :label="$t('全部状态')" value="" /><el-option v-for="(label, key) in statuses" :key="key" :label="$t(label)" :value="key" /></el-select>
      </template>
      <template v-else>
        <button v-if="historyGrantId" class="access-filter" type="button" @click="clearGrantFilter">{{ $t('当前授权的记录') }}<X :size="13" /></button>
        <el-select v-model="historyAction" :empty-values="[null, undefined]" :aria-label="$t('记录类型')"><el-option :label="$t('全部记录')" value="" /><el-option v-for="(label, key) in actions" :key="key" :label="$t(label)" :value="key" /></el-select>
      </template>
    </div>
    <div v-if="loadError" class="access-empty" role="alert"><span>{{ loadError }}</span><el-button @click="load">{{ $t('重试') }}</el-button></div>
    <template v-else-if="tab === 'requests'">
      <div v-if="requests.length" class="access-ledger">
        <div class="access-ledger__head"><span>{{ $t('申请资源 / 用途') }}</span><span>{{ $t('申请人') }}</span><span>{{ $t('审批进度') }}</span><span>{{ $t('状态') }}</span><span>{{ $t('提交时间') }}</span></div>
        <button v-for="item in requests" :key="item.id" type="button" class="access-ledger__row" @click="openRequest(item)">
          <span class="access-identity"><strong>{{ item.snapshot.label }}</strong><small :title="item.reason">{{ item.reason }}</small></span>
          <span>{{ item.requesterName }}</span>
          <span class="access-progress"><strong>{{ item.status === 'pending' ? item.workflow.stages[item.stageIndex]?.name : $t(statuses[item.status]) }}</strong><small>{{ Math.min(item.stageIndex, item.workflow.stages.length) }} / {{ item.workflow.stages.length }}</small></span>
          <span><em class="access-status" :class="`is-${item.status}`">{{ $t(statuses[item.status]) }}</em></span><time>{{ formatDate(item.createdAt) }}</time>
        </button>
      </div>
      <div v-else class="access-empty"><ShieldCheck :size="26" /><strong>{{ $t(view === 'todo' ? '暂无待你审批的申请' : '暂无授权申请') }}</strong><span>{{ $t('每次申请与审批都会保留完整记录。') }}</span></div>
    </template>
    <template v-else>
      <div v-if="events.length" class="access-ledger is-history">
        <div class="access-ledger__head"><span>{{ $t('操作 / 资源') }}</span><span>{{ $t('操作人') }}</span><span>{{ $t('原因') }}</span><span>{{ $t('发生时间') }}</span></div>
        <button v-for="event in events" :key="event.id" type="button" class="access-ledger__row" @click="openEvent(event)">
          <span class="access-identity"><strong>{{ $t(actions[event.action]) }} <em v-if="event.details.selfApproved" class="access-self">{{ $t('自审批') }}</em></strong><small>{{ (event.after || event.before)?.label || $t('组织审批流程') }}<template v-if="event.after || event.before"> · {{ (event.after || event.before)?.granteeName }}</template></small></span>
          <span>{{ event.actorName }}</span><span class="access-reason" :title="event.reason">{{ event.reason }}</span><time>{{ formatDate(event.createdAt) }}</time>
        </button>
      </div>
      <div v-else class="access-empty"><History :size="26" /><strong>{{ $t('暂无授权记录') }}</strong></div>
    </template>
    <footer class="access-pagination"><small>{{ $t('第 {0} 页', [page]) }}</small><el-button :disabled="page === 1 || loading" @click="nextPage(-1)">{{ $t('上一页') }}</el-button><el-button :disabled="!hasMore || loading" @click="nextPage(1)">{{ $t('下一页') }}</el-button></footer>
  </section>

  <el-dialog append-to-body v-model="requestDialog" align-center class="envman-dialog access-detail-dialog" :title="$t('授权申请详情')" width="min(820px, calc(100vw - 32px))">
    <template v-if="selectedRequest">
      <div class="access-detail-heading"><div><h3>{{ selectedRequest.snapshot.label }}</h3><p>{{ selectedRequest.requesterName }} · {{ formatDate(selectedRequest.createdAt) }}</p></div><em class="access-status" :class="`is-${selectedRequest.status}`">{{ $t(statuses[selectedRequest.status]) }}</em></div>
      <dl class="access-facts"><div><dt>{{ $t('申请理由') }}</dt><dd>{{ selectedRequest.reason }}</dd></div><div><dt>{{ $t('权限') }}</dt><dd>{{ permissionText(selectedRequest.snapshot.permissions) }}</dd></div><div><dt>{{ $t('对象范围') }}</dt><dd>{{ snapshotItemScope(selectedRequest.snapshot) }}</dd></div><div><dt>{{ $t('有效至') }}</dt><dd>{{ formatDate(selectedRequest.snapshot.expiresAt) }}</dd></div></dl>
      <h4 class="access-section-title"><GitBranch :size="15" />{{ selectedRequest.workflow.name }}</h4>
      <ol class="approval-flow">
        <li v-for="(stage, index) in selectedRequest.workflow.stages" :key="index" :class="{ 'is-complete': index < selectedRequest.stageIndex, 'is-current': index === selectedRequest.stageIndex && selectedRequest.status === 'pending' }">
          <span class="approval-flow__number"><Check v-if="index < selectedRequest.stageIndex" :size="14" /><template v-else>{{ index + 1 }}</template></span>
          <div><strong>{{ stage.name }}</strong><small>{{ stageNames(selectedRequest, index) }} · {{ $t(stage.mode === 'all' ? '全部审批人通过' : '任一审批人通过') }}</small><small v-if="index === selectedRequest.stageIndex && selectedRequest.stageApprovals.length">{{ $t('已通过：{0}', [selectedRequest.stageApprovals.map((id) => selectedRequest!.approverNames[id]).join('、')]) }}</small></div><em>{{ stageStatus(selectedRequest, index) }}</em>
        </li>
      </ol>
      <h4 class="access-section-title"><History :size="15" />{{ $t('流转记录') }}</h4>
      <ol class="access-event-list"><li v-for="event in requestEvents" :key="event.id"><span class="access-event-dot"></span><div><strong>{{ event.actorName }} · {{ $t(actions[event.action]) }}<em v-if="event.details.selfApproved" class="access-self">{{ $t('自审批') }}</em></strong><small v-if="event.details.stageName">{{ event.details.stageName }}</small><p>{{ event.reason }}</p><time>{{ formatDate(event.createdAt) }}</time></div></li></ol>
      <div v-if="selectedRequest.canApprove || selectedRequest.canWithdraw" class="access-decision">
        <p v-if="selectedRequest.canApprove && selectedRequest.requesterId === session.user?.id">{{ $t('允许配置的审批人审批自己的申请，系统会记录审批人身份。') }}</p>
        <el-input v-model="decisionReason" type="textarea" :rows="2" maxlength="2000" :aria-label="$t('处理原因')" :placeholder="$t('填写审批意见或撤回原因')" />
        <div><el-button v-if="selectedRequest.canWithdraw" :disabled="acting || !decisionReason.trim()" @click="decide('withdraw')">{{ $t('撤回申请') }}</el-button><span></span><el-button v-if="selectedRequest.canApprove" type="danger" plain :disabled="acting || !decisionReason.trim()" @click="decide('reject')">{{ $t('拒绝') }}</el-button><el-button v-if="selectedRequest.canApprove" type="primary" :loading="acting" :disabled="!decisionReason.trim()" @click="decide('approve')">{{ $t('通过当前节点') }}</el-button></div>
      </div>
    </template>
    <template #footer><el-button :disabled="acting" @click="requestDialog = false">{{ $t('关闭') }}</el-button></template>
  </el-dialog>

  <el-dialog append-to-body v-model="workflowDialog" align-center class="envman-dialog" :title="$t('配置授权审批流程')" width="min(760px, calc(100vw - 32px))">
    <div class="access-notice"><GitBranch :size="18" /><span>{{ $t('按顺序审批，全部节点通过后生效。允许自审批；流程修改只影响新申请。') }}</span></div>
    <el-form label-position="top" @submit.prevent="saveWorkflow">
      <el-form-item :label="$t('流程名称')" required><el-input v-model="workflowDraft.name" maxlength="120" /></el-form-item>
      <div v-for="(stage, index) in workflowDraft.stages" :key="index" class="workflow-stage">
        <header><strong>{{ $t('节点 {0}', [index + 1]) }}</strong><span></span><button type="button" :disabled="index === 0" :aria-label="$t('上移节点')" @click="moveStage(index, -1)"><ArrowUp :size="14" /></button><button type="button" :disabled="index === workflowDraft.stages.length - 1" :aria-label="$t('下移节点')" @click="moveStage(index, 1)"><ArrowDown :size="14" /></button><button type="button" :aria-label="$t('删除节点')" @click="workflowDraft.stages.splice(index, 1)"><Trash2 :size="14" /></button></header>
        <el-form-item :label="$t('节点名称')" required><el-input v-model="stage.name" maxlength="120" /></el-form-item>
        <el-form-item :label="$t('审批人')" required><el-select v-model="stage.approverIds" multiple filterable :placeholder="$t('选择组织成员')"><el-option v-for="member in activeMembers" :key="member.id" :label="member.username" :value="member.id" /></el-select></el-form-item>
        <el-form-item :label="$t('通过规则')"><el-radio-group v-model="stage.mode"><el-radio value="any">{{ $t('任一审批人通过') }}</el-radio><el-radio value="all">{{ $t('全部审批人通过') }}</el-radio></el-radio-group></el-form-item>
      </div>
      <el-button :disabled="workflowDraft.stages.length >= 10" @click="addStage"><Plus :size="14" />{{ $t('添加审批节点') }}</el-button>
    </el-form>
    <template #footer><el-button :disabled="savingWorkflow" @click="workflowDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="savingWorkflow" :disabled="!workflowValid" @click="saveWorkflow">{{ $t('保存流程') }}</el-button></template>
  </el-dialog>

  <el-dialog append-to-body v-model="eventDialog" align-center class="envman-dialog" :title="$t('授权记录详情')" width="min(760px, calc(100vw - 32px))">
    <template v-if="selectedEvent">
      <div class="access-detail-heading"><div><h3>{{ $t(actions[selectedEvent.action]) }}</h3><p>{{ selectedEvent.actorName }} · {{ formatDate(selectedEvent.createdAt) }}</p></div><em v-if="selectedEvent.details.selfApproved" class="access-self">{{ $t('自审批') }}</em></div>
      <dl class="access-facts"><div><dt>{{ $t('原因') }}</dt><dd>{{ selectedEvent.reason }}</dd></div><div><dt>{{ $t('授权来源') }}</dt><dd>{{ $t(selectedEvent.source === 'request' ? '申请审批' : selectedEvent.source === 'system' ? '系统处理' : '主动授权') }}</dd></div><div v-if="selectedEvent.requestId"><dt>{{ $t('申请单号') }}</dt><dd class="access-reference">{{ selectedEvent.requestId }}</dd></div><div v-if="selectedEvent.grantId"><dt>{{ $t('授权编号') }}</dt><dd class="access-reference">{{ selectedEvent.grantId }}</dd></div></dl>
      <div class="access-snapshots"><section v-for="entry in [{ label: '变更前', snapshot: selectedEvent.before }, { label: '变更后', snapshot: selectedEvent.after }].filter((entry) => entry.snapshot)" :key="entry.label"><h4>{{ $t(entry.label) }}</h4><strong>{{ entry.snapshot!.label }}</strong><p>{{ entry.snapshot!.granteeName }}</p><p>{{ permissionText(entry.snapshot!.permissions) }}</p><small>{{ snapshotItemScope(entry.snapshot!) }}</small><time>{{ $t('有效至') }} {{ formatDate(entry.snapshot!.expiresAt) }}</time></section></div>
      <div v-if="selectedEvent.action === 'workflow_updated'" class="access-snapshots"><section v-for="entry in [{ label: '变更前', flow: selectedEvent.details.before as ApprovalWorkflow | null }, { label: '变更后', flow: selectedEvent.details.after as ApprovalWorkflow | null }].filter((entry) => entry.flow)" :key="entry.label"><h4>{{ $t(entry.label) }} · {{ entry.flow!.name }}</h4><ol><li v-for="stage in entry.flow!.stages" :key="stage.name">{{ stage.name }} · {{ $t(stage.mode === 'all' ? '全部审批人通过' : '任一审批人通过') }}</li></ol></section></div>
    </template>
    <template #footer><el-button @click="eventDialog = false">{{ $t('关闭') }}</el-button></template>
  </el-dialog>
</template>

<style scoped src="./organization-access.css"></style>
