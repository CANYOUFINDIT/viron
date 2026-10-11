<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../../api";
import { useOrganizationContext } from "./context";
import { pendingResourceGrant } from "./grant-selection";

const props = defineProps<{ view: "grants" | "requests" | "todo" }>();
const { currentOrganizationId } = useOrganizationContext();
const access = ref<{ roles: Array<Record<string, any>>; dataGrants: Array<Record<string, any>>; featureGrants: Array<Record<string, any>> }>({ roles: [], dataGrants: [], featureGrants: [] });
const requests = ref<Array<Record<string, any>>>([]);
const error = ref("");
const form = ref({ kind: "data" as "data" | "feature", roleId: "", targetType: "ssh_connection", targetId: "", reason: "申请授权", durationMs: "", mcp: false, agent: false, webPlugins: false });
const message = ref("");

async function load() {
  const organizationId = currentOrganizationId.value;
  if (!organizationId) return;
  error.value = "";
  try {
    access.value = await api(`/api/v1/organizations/${organizationId}/my-access`);
    const view = props.view === "todo" ? "todo" : "mine";
    requests.value = (await api<{ items: Array<Record<string, any>> }>(`/api/v1/organizations/${organizationId}/grant-requests?view=${view}`)).items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "我的授权加载失败";
  }
}

watch(() => [currentOrganizationId.value, props.view], load, { immediate: true });
watch(pendingResourceGrant, (target) => {
  if (!target || props.view !== "requests") return;
  form.value.targetType = target.type;
  form.value.targetId = target.id;
  pendingResourceGrant.value = null;
}, { immediate: true });

async function submit() {
  const organizationId = currentOrganizationId.value;
  message.value = "";
  try {
    await api(`/api/v1/organizations/${organizationId}/grant-requests`, {
      method: "POST",
      body: JSON.stringify({
        kind: form.value.kind,
        roleId: form.value.kind === "data" ? form.value.roleId : null,
        features: form.value.kind === "feature" ? { mcp: form.value.mcp, agent: form.value.agent, webPlugins: form.value.webPlugins } : null,
        targets: [{ type: form.value.targetType, id: form.value.targetId }],
        durationMs: form.value.durationMs ? Number(form.value.durationMs) : null,
        reason: form.value.reason,
      }),
    });
    message.value = "申请已提交";
    await load();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "申请提交失败";
  }
}

async function decide(id: string, decision: "approve" | "reject") {
  const organizationId = currentOrganizationId.value;
  message.value = "";
  try {
    await api(`/api/v1/organizations/${organizationId}/grant-requests/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, comment: decision === "approve" ? "同意" : "拒绝" }) });
    message.value = decision === "approve" ? "已通过" : "已拒绝";
    await load();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "处理失败";
  }
}

async function revise(id: string, type: "transfer" | "add_sign" | "rollback") {
  const organizationId = currentOrganizationId.value;
  const userId = type === "rollback" ? undefined : window.prompt("成员 ID") ?? "";
  if (type !== "rollback" && !userId) return;
  message.value = "";
  try {
    await api(`/api/v1/organizations/${organizationId}/grant-requests/${id}/revise`, {
      method: "POST",
      body: JSON.stringify({ type, userId, comment: type === "rollback" ? "回退" : "调整审批人" }),
    });
    message.value = "节点已调整";
    await load();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "节点调整失败";
  }
}

async function withdraw(id: string) {
  const organizationId = currentOrganizationId.value;
  await api(`/api/v1/organizations/${organizationId}/grant-requests/${id}/withdraw`, { method: "POST", body: JSON.stringify({ reason: "撤回申请" }) });
  await load();
}
</script>

<template>
  <section class="console-panel" :aria-label="view === 'grants' ? '我的授权' : view === 'requests' ? '我的申请' : '待我审批'">
    <p v-if="error">{{ error }}</p>
    <p v-if="message">{{ message }}</p>
    <template v-if="view === 'grants'">
      <h3>已分配角色</h3>
      <p v-if="!access.roles.length">暂无角色</p>
      <article v-for="role in access.roles" :key="role.id">
        <strong>{{ role.name }}</strong>
        <small>{{ role.source === "direct" ? "直接" : "继承" }} · {{ role.status }}</small>
        <small v-if="!role.managesResources">目录或管理角色，不表示资源使用权</small>
      </article>
      <h3>数据授权</h3>
      <p v-if="!access.dataGrants.length">暂无数据授权</p>
      <article v-for="grant in access.dataGrants" :key="grant.id">
        <strong>{{ grant.roleName }} · {{ grant.name }}</strong>
        <small>{{ grant.status }}<template v-if="grant.expiresAt"> · {{ grant.expiresAt }}</template></small>
      </article>
      <h3>功能授权</h3>
      <p v-if="!access.featureGrants.length">暂无功能授权</p>
      <article v-for="grant in access.featureGrants" :key="grant.id">
        <strong>{{ grant.features.mcp ? "MCP " : "" }}{{ grant.features.agent ? "Agent " : "" }}{{ grant.features.webPlugins ? "Web 插件" : "" }}</strong>
        <small>{{ grant.source === "direct" ? "直接" : "继承" }} · {{ grant.status }}</small>
      </article>
    </template>
    <form v-if="view === 'requests'" @submit.prevent="submit">
      <h3>申请数据授权</h3>
      <label>类型
        <select v-model="form.kind">
          <option value="data">申请数据授权</option>
          <option value="feature">申请功能授权</option>
        </select>
      </label>
      <label v-if="form.kind === 'data'">角色
        <select v-model="form.roleId">
          <option v-for="role in access.roles" :key="role.roleId" :value="role.roleId">{{ role.name }}</option>
        </select>
      </label>
      <fieldset v-else>
        <legend>功能标记</legend>
        <label><input v-model="form.mcp" type="checkbox" />MCP</label>
        <label><input v-model="form.agent" type="checkbox" />Agent</label>
        <label><input v-model="form.webPlugins" type="checkbox" />Web 插件</label>
      </fieldset>
      <label>资源类型 <input v-model="form.targetType" /></label>
      <label>资源 <input v-model="form.targetId" placeholder="资源 ID" /></label>
      <label>时长毫秒 <input v-model="form.durationMs" placeholder="空为永久" /></label>
      <label>原因 <input v-model="form.reason" /></label>
      <button type="submit">提交申请</button>
    </form>
    <article v-for="item in requests" :key="item.id">
      <strong>{{ item.kind === "data" ? "数据申请" : "功能申请" }} · {{ item.status }}</strong>
      <small>{{ item.reason }}</small>
      <small v-if="item.blockReason">{{ item.blockReason }}</small>
      <button v-if="view === 'requests' && item.canWithdraw" type="button" @click="withdraw(item.id)">撤回</button>
      <template v-if="view === 'todo' && item.canDecide">
        <button v-if="item.canApprove" type="button" @click="decide(item.id, 'approve')">通过</button>
        <button v-if="item.canReject" type="button" @click="decide(item.id, 'reject')">拒绝</button>
        <button type="button" @click="revise(item.id, 'transfer')">转交</button>
        <button type="button" @click="revise(item.id, 'add_sign')">加签</button>
        <button type="button" @click="revise(item.id, 'rollback')">回退</button>
      </template>
    </article>
  </section>
</template>
