<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../../api";
import { workspaceCan } from "../../session";
import { useOrganizationContext } from "./context";

const { activePanel, currentOrganizationId } = useOrganizationContext();
const flows = ref<Array<Record<string, any>>>([]);
const ledger = ref<Array<Record<string, any>>>([]);
const error = ref("");
const name = ref("指定连接");
const targetId = ref("");
const mode = ref("any");
const message = ref("");
const modes = [
  ["any", "或签"],
  ["all", "会签"],
  ["sequence", "依次审批"],
  ["cc", "抄送"],
  ["auto_approve", "自动通过"],
  ["auto_reject", "自动拒绝"],
] as const;

function nodeModes(flow: { nodes?: Array<{ mode?: string }> }) {
  return (flow.nodes ?? []).map((node) => node.mode).join("、");
}

async function load() {
  const organizationId = currentOrganizationId.value;
  if (!organizationId) return;
  error.value = "";
  try {
    flows.value = (await api<{ items: Array<Record<string, any>> }>(`/api/v1/organizations/${organizationId}/approval-flows`)).items;
    ledger.value = (await api<{ items: Array<Record<string, any>> }>(`/api/v1/organizations/${organizationId}/grant-ledger`)).items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "审批与台账加载失败";
  }
}

watch(currentOrganizationId, load, { immediate: true });

async function saveFlow() {
  const organizationId = currentOrganizationId.value;
  message.value = "";
  const approver = flows.value.find((flow) => flow.isDefault)?.nodes?.[0];
  try {
    await api(`/api/v1/organizations/${organizationId}/approval-flows`, {
      method: "POST",
      body: JSON.stringify({
        name: name.value,
        nodes: [{
          id: crypto.randomUUID(),
          name: "审批",
          mode: mode.value,
          approverUserIds: approver?.approverUserIds ?? [],
          approverRoleId: approver?.approverRoleId ?? null,
          allowSelf: false,
          requireComment: false,
        }],
        targets: [{ type: "ssh_connection", id: targetId.value }],
      }),
    });
    message.value = "审批流程已保存";
    await load();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "保存失败";
  }
}
</script>

<template>
  <section class="console-panel" aria-label="审批与台账">
    <p v-if="error">{{ error }}</p>
    <p v-if="message">{{ message }}</p>
    <h3>审批流程</h3>
    <article v-for="flow in flows" :key="flow.id">
      <strong>{{ flow.name }}</strong>
      <small>{{ flow.isDefault ? "默认流程" : "指定流程" }} · 覆盖 {{ flow.coverage }} · {{ nodeModes(flow) }}</small>
    </article>
    <form v-if="workspaceCan('approval.workflow')" @submit.prevent="saveFlow">
      <label>流程名称 <input v-model="name" /></label>
      <label>节点
        <select v-model="mode">
          <option v-for="item in modes" :key="item[0]" :value="item[0]">{{ item[1] }}</option>
        </select>
      </label>
      <label>连接 <input v-model="targetId" placeholder="连接 ID" /></label>
      <button type="submit">保存指定流程</button>
    </form>
    <h3>台账</h3>
    <p v-if="!ledger.length">暂无台账</p>
    <article v-for="row in ledger" :key="row.id">
      <strong>{{ row.action }}</strong>
      <small>{{ row.actorName }} · {{ row.reason }}</small>
    </article>
    <button type="button" @click="activePanel = 'access'">历史授权</button>
  </section>
</template>
