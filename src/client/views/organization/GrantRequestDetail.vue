<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../../api";
import { RESOURCE_TYPE_LABELS, type ResourceType } from "../../../shared/organization-rbac";
import RolePermissionList from "./RolePermissionList.vue";
import { formatDuration } from "./grant-selection";

const props = defineProps<{ modelValue: boolean; organizationId: string; requestId: string }>();
const emit = defineEmits<{ "update:modelValue": [boolean]; changed: [] }>();
const open = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });

interface Person { id: string; name: string; nameSource?: string; canApprove?: boolean; canReject?: boolean }
interface TargetView { type: ResourceType; id: string; name: string; typeName?: string; environmentName?: string }
interface RequestNode {
  id: string;
  name: string;
  mode: string;
  resolution: string;
  allowSelf: boolean;
  requireComment: boolean;
  allowTransfer: boolean;
  allowAddSign: boolean;
  allowRollback: boolean;
  approvers: Person[];
}
interface DecisionView {
  decision: string;
  actorName?: string;
  comment?: string;
  at?: string;
  nameSource?: string;
  superseded?: boolean;
  automatic?: boolean;
  stageIndex?: number;
  recipients?: Array<{ id: string; name: string; nameSource: string }>;
}
interface RollbackTarget { stageIndex: number; id: string; name: string; mode: string }
interface GrantRequestDetail {
  id: string;
  kind: "data" | "feature";
  status: string;
  reason: string;
  flowName: string;
  paused: boolean;
  pauseReason: string;
  blockReason: string;
  requesterName: string;
  namesFrozen: boolean;
  roleName: string | null;
  features: { mcp: boolean; agent: boolean; webPlugins: boolean } | null;
  targets: TargetView[];
  permissionCodes: string[];
  holderNames: Record<string, string>;
  durationMs: number | null;
  stageIndex: number;
  requireComment: boolean;
  nodes: RequestNode[];
  decisions: DecisionView[];
  canApprove: boolean;
  canReject: boolean;
  canTransfer: boolean;
  canAddSign: boolean;
  canRollback: boolean;
  canWithdraw: boolean;
  rollbackTargets: RollbackTarget[];
  revisionCandidates: Person[];
}
const detail = ref<GrantRequestDetail | null>(null);
const loading = ref(false);
const error = ref("");
const comment = ref("");
const withdrawReason = ref("");
const reviseComment = ref("");
const transferUserId = ref("");
const addSignUserId = ref("");
const rollbackIndex = ref<number | null>(null);
const busy = ref(false);
const notice = ref("");

const modeLabel: Record<string, string> = {
  any: "或签", all: "会签", sequence: "依次审批", cc: "抄送", auto_approve: "自动通过", auto_reject: "自动拒绝",
};
const decisionLabel: Record<string, string> = {
  approve: "通过", reject: "拒绝", withdraw: "撤回", cc: "抄送", transfer: "转交", add_sign: "加签", rollback: "回退",
};
const statusLabel: Record<string, string> = { pending: "待审批", approved: "已通过", rejected: "已拒绝", withdrawn: "已撤回" };

const holders = computed(() => Object.values(detail.value?.holderNames ?? {}).filter(Boolean));
const currentNode = computed(() => {
  const row = detail.value;
  if (!row || row.status !== "pending") return null;
  return row.nodes[row.stageIndex] ?? null;
});

function featureText(features: GrantRequestDetail["features"]) {
  if (!features) return "无";
  return [features.mcp && "MCP", features.agent && "Agent", features.webPlugins && "Web 插件"].filter(Boolean).join("、") || "未选功能";
}
function targetText(target: TargetView) {
  const typeName = target.typeName || RESOURCE_TYPE_LABELS[target.type] || target.type;
  const name = target.name?.trim() || "未命名资源";
  const environment = target.type === "environment" ? "" : target.environmentName?.trim();
  return environment ? `${typeName} · ${name} · ${environment}` : `${typeName} · ${name}`;
}
function people(list: Person[]) {
  return list.map((person) => person.name || "未记录名称").join("、") || "无";
}
function nameNote(source?: string) {
  return source === "snapshot" || source === "ledger" ? "处理当时的名称" : "";
}
function when(value?: string) {
  if (!value) return "未记录时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function load() {
  if (!props.modelValue || !props.requestId) return;
  loading.value = true;
  error.value = "";
  notice.value = "";
  try {
    detail.value = await api<GrantRequestDetail>(`/api/v1/organizations/${props.organizationId}/grant-requests/${props.requestId}`);
    rollbackIndex.value = detail.value.rollbackTargets[0]?.stageIndex ?? null;
    transferUserId.value = "";
    addSignUserId.value = "";
  } catch (cause) {
    detail.value = null;
    error.value = cause instanceof Error ? cause.message : "申请详情加载失败";
  } finally {
    loading.value = false;
  }
}
watch(() => [props.modelValue, props.requestId, props.organizationId] as const, load, { immediate: true });

async function run(action: () => Promise<void>) {
  busy.value = true;
  notice.value = "";
  try {
    await action();
    emit("changed");
    await load();
  } catch (cause) {
    notice.value = cause instanceof Error ? cause.message : "处理失败";
  } finally {
    busy.value = false;
  }
}
function decide(decision: "approve" | "reject") {
  const row = detail.value;
  if (!row) return;
  if (row.requireComment && !comment.value.trim()) {
    notice.value = "这个节点要求填写意见";
    return;
  }
  void run(async () => {
    await api(`/api/v1/organizations/${props.organizationId}/grant-requests/${row.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, comment: comment.value.trim() }),
    });
    comment.value = "";
    notice.value = decision === "approve" ? "已提交通过" : "已提交拒绝";
  });
}
function withdraw() {
  const row = detail.value;
  if (!row || !withdrawReason.value.trim()) {
    notice.value = "撤回需要填写原因";
    return;
  }
  void run(async () => {
    await api(`/api/v1/organizations/${props.organizationId}/grant-requests/${row.id}/withdraw`, {
      method: "POST",
      body: JSON.stringify({ reason: withdrawReason.value.trim() }),
    });
    withdrawReason.value = "";
    notice.value = "已撤回";
  });
}
function revise(type: "transfer" | "add_sign" | "rollback") {
  const row = detail.value;
  if (!row || !reviseComment.value.trim()) {
    notice.value = "调整节点需要填写意见";
    return;
  }
  const userId = type === "transfer" ? transferUserId.value : type === "add_sign" ? addSignUserId.value : undefined;
  if (type !== "rollback" && !userId) {
    notice.value = "请选择合格成员";
    return;
  }
  if (type === "rollback" && rollbackIndex.value === null) {
    notice.value = "请选择要回退到的节点";
    return;
  }
  void run(async () => {
    await api(`/api/v1/organizations/${props.organizationId}/grant-requests/${row.id}/revise`, {
      method: "POST",
      body: JSON.stringify({
        type,
        comment: reviseComment.value.trim(),
        ...(userId ? { userId } : {}),
        ...(type === "rollback" ? { stageIndex: rollbackIndex.value } : {}),
      }),
    });
    reviseComment.value = "";
    notice.value = "节点已调整，原处理记录仍保留";
  });
}
</script>

<template>
  <el-dialog v-model="open" title="申请详情" width="min(880px, calc(100% - 32px))" append-to-body align-center class="envman-dialog request-detail-dialog">
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="notice" :title="notice" type="info" :closable="false" />
      <template v-if="detail">
        <el-alert v-if="detail.pauseReason || detail.blockReason" :title="detail.pauseReason || detail.blockReason" type="warning" :closable="false" />
        <dl class="request-facts">
          <div><dt>类型</dt><dd>{{ detail.kind === "data" ? "数据授权申请" : "功能授权申请" }}</dd></div>
          <div><dt>状态</dt><dd>{{ statusLabel[detail.status] ?? detail.status }}</dd></div>
          <div><dt>申请人</dt><dd>{{ detail.requesterName || "未记录申请人" }}</dd></div>
          <div><dt>流程</dt><dd>{{ detail.flowName || "未记录流程" }}</dd></div>
          <div><dt>时长</dt><dd>{{ formatDuration(detail.durationMs) }}</dd></div>
          <div><dt>理由</dt><dd>{{ detail.reason }}</dd></div>
        </dl>
        <p v-if="detail.namesFrozen" class="request-note">角色、共享成员、目标和申请人名称是提交时的快照。上面的阻塞原因来自当前读取。</p>
        <section v-if="detail.kind === 'data'">
          <h4>角色与共享成员</h4>
          <p>{{ detail.roleName || "未记录角色" }}</p>
          <p>提交时的有效共享成员：{{ holders.join("、") || "未记录" }}</p>
          <RolePermissionList :codes="detail.permissionCodes" />
        </section>
        <section v-else>
          <h4>功能标记</h4>
          <p>{{ featureText(detail.features) }}</p>
        </section>
        <section>
          <h4>目标</h4>
          <p v-for="target in detail.targets" :key="`${target.type}:${target.id}`">{{ targetText(target) }}</p>
          <p v-if="!detail.targets.length">未记录目标</p>
        </section>
        <section>
          <h4>节点</h4>
          <article v-for="(node, index) in detail.nodes" :key="node.id" :class="{ 'is-current': detail.status === 'pending' && index === detail.stageIndex }">
            <strong>{{ index + 1 }}. {{ node.name }} · {{ modeLabel[node.mode] ?? node.mode }}</strong>
            <p v-if="index < detail.stageIndex || detail.status !== 'pending'">{{ index < detail.stageIndex ? "已经过" : "" }}</p>
            <p>选择依据：{{ node.resolution || "未记录" }}</p>
            <p>{{ node.mode === "cc" ? "抄送接收" : "快照人员" }}：{{ people(node.approvers) }}</p>
            <p>{{ node.allowSelf ? "允许申请人本人审批并记录" : "不包含申请人本人" }} · {{ node.requireComment ? "必须填写意见" : "意见可选" }}</p>
            <p v-if="node.mode !== 'cc'">转交 {{ node.allowTransfer ? "开启" : "关闭" }} · 加签 {{ node.allowAddSign ? "开启" : "关闭" }} · 回退 {{ node.allowRollback ? "开启" : "关闭" }}</p>
          </article>
        </section>
        <section>
          <h4>处理历史</h4>
          <article v-for="(item, index) in detail.decisions" :key="`${item.at}-${index}`">
            <strong>{{ decisionLabel[item.decision] ?? item.decision }} · {{ item.actorName || "未记录处理人" }}</strong>
            <small v-if="nameNote(item.nameSource)">{{ nameNote(item.nameSource) }}</small>
            <small>{{ when(item.at) }}<template v-if="item.superseded"> · 已保留，后续回退使其不再作为通过依据</template><template v-if="item.automatic"> · 自动</template></small>
            <p v-if="item.comment">{{ item.comment }}</p>
            <p v-if="item.recipients?.length">抄送接收：{{ item.recipients.map((person) => person.name || "未记录名称").join("、") }}</p>
          </article>
          <p v-if="!detail.decisions.length">还没有处理记录</p>
        </section>
        <section v-if="currentNode">
          <h4>当前节点</h4>
          <p>{{ currentNode.name }} · {{ modeLabel[currentNode.mode] ?? currentNode.mode }}</p>
        </section>
        <section v-if="detail.canApprove || detail.canReject">
          <h4>意见</h4>
          <el-input v-model="comment" type="textarea" :rows="3" maxlength="2000" :placeholder="detail.requireComment ? '此节点必须填写意见' : '可以填写意见'" />
          <div class="request-actions">
            <el-button v-if="detail.canApprove" type="primary" :disabled="busy" @click="decide('approve')">通过</el-button>
            <el-button v-if="detail.canReject" :disabled="busy" @click="decide('reject')">拒绝</el-button>
          </div>
        </section>
        <section v-if="detail.canTransfer || detail.canAddSign || detail.canRollback">
          <h4>调整当前节点</h4>
          <el-input v-model="reviseComment" type="textarea" :rows="2" maxlength="2000" placeholder="填写调整意见" />
          <label v-if="detail.canTransfer">转交给
            <el-select v-model="transferUserId" placeholder="选择合格成员" style="width: 100%">
              <el-option v-for="person in detail.revisionCandidates" :key="person.id" :label="person.name" :value="person.id" />
            </el-select>
          </label>
          <label v-if="detail.canAddSign">加签
            <el-select v-model="addSignUserId" placeholder="选择合格成员" style="width: 100%">
              <el-option v-for="person in detail.revisionCandidates" :key="person.id" :label="person.name" :value="person.id" />
            </el-select>
          </label>
          <label v-if="detail.canRollback">回退到
            <el-select v-model="rollbackIndex" placeholder="选择先前节点" style="width: 100%">
              <el-option v-for="node in detail.rollbackTargets" :key="node.stageIndex" :label="`${node.stageIndex + 1}. ${node.name} · ${modeLabel[node.mode] ?? node.mode}`" :value="node.stageIndex" />
            </el-select>
          </label>
          <div class="request-actions">
            <el-button v-if="detail.canTransfer" :disabled="busy" @click="revise('transfer')">转交</el-button>
            <el-button v-if="detail.canAddSign" :disabled="busy" @click="revise('add_sign')">加签</el-button>
            <el-button v-if="detail.canRollback" :disabled="busy" @click="revise('rollback')">回退</el-button>
          </div>
        </section>
        <section v-if="detail.canWithdraw">
          <h4>撤回</h4>
          <el-input v-model="withdrawReason" maxlength="2000" placeholder="填写撤回原因" />
          <div class="request-actions"><el-button :disabled="busy" @click="withdraw">撤回申请</el-button></div>
        </section>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.request-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin: 12px 0; }
.request-facts div { min-width: 0; }
.request-facts dt { color: var(--el-text-color-secondary); font-size: 12px; }
.request-facts dd { margin: 2px 0 0; }
.request-note { color: var(--el-text-color-secondary); font-size: 12px; }
section { margin-top: 16px; }
h4 { margin: 0 0 8px; font-size: 13px; }
article { padding: 8px 0; border-top: 1px solid var(--el-border-color-lighter); }
article.is-current { background: var(--el-fill-color-light); }
article p, article small { display: block; margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
label { display: block; margin-top: 8px; font-size: 12px; }
.request-actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
