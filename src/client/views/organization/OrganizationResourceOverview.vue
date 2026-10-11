<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../../api";
import { workspaceCan } from "../../session";
import { useOrganizationContext } from "./context";
import { pendingResourceGrant } from "./grant-selection";
import { RESOURCE_TYPES, type ResourceType } from "../../../shared/organization-rbac";

const props = defineProps<{ projectId?: string }>();
const { activePanel, currentOrganizationId } = useOrganizationContext();
const labels = [
  { id: "environments", label: "环境总览" },
  { id: "credentials", label: "密钥与证书" },
  { id: "ssh", label: "SSH 工作台" },
  { id: "database", label: "数据库工作台" },
  { id: "redis", label: "Redis 工作台" },
  { id: "knowledge", label: "知识库" },
];
const entries = ref<Array<{ id: string; label: string; count: number; items: Array<Record<string, any>> }>>(
  labels.map((entry) => ({ ...entry, count: 0, items: [] })),
);
const selected = ref("environments");
const error = ref("");
const current = computed(() => entries.value.find((entry) => entry.id === selected.value) ?? entries.value[0]);

async function load() {
  const organizationId = currentOrganizationId.value;
  if (!organizationId) return;
  error.value = "";
  try {
    const query = props.projectId ? `?projectId=${encodeURIComponent(props.projectId)}` : "";
    const result = await api<{ entries: typeof entries.value }>(`/api/v1/organizations/${organizationId}/resource-overview${query}`);
    entries.value = labels.map((entry) => result.entries.find((item) => item.id === entry.id) ?? { ...entry, count: 0, items: [] });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "资源总览加载失败";
  }
}

watch(() => [currentOrganizationId.value, props.projectId], load, { immediate: true });

function openGrant(item: { type?: string; id?: string }) {
  pendingResourceGrant.value = item.type && item.id && RESOURCE_TYPES.includes(item.type as ResourceType)
    ? { type: item.type as ResourceType, id: item.id }
    : null;
  activePanel.value = workspaceCan("authorization.create") ? "roles" : "requests";
}
</script>

<template>
  <section class="console-panel organization-overview" aria-label="资源总览">
    <nav class="console-tabs" aria-label="资源入口">
      <button v-for="entry in entries" :key="entry.id" type="button" :class="{ 'is-active': selected === entry.id }" @click="selected = entry.id">
        {{ entry.label }} <small>{{ entry.count }}</small>
      </button>
    </nav>
    <p v-if="error">{{ error }}</p>
    <p v-else-if="!current.items.length">暂无数据</p>
    <div v-else class="organization-card-grid">
      <article v-for="item in current.items" :key="`${item.type}-${item.id}`">
        <strong>{{ item.name || item.fingerprint }}</strong>
        <small v-if="item.environmentAuthorized === false">未授权整个环境</small>
        <small v-else-if="item.environmentAuthorized">环境已授权</small>
        <small v-if="item.partial">仅部分连接已授权</small>
        <small v-if="item.operationWindow?.label">{{ item.operationWindow.label }}</small>
        <span>
          <button v-if="workspaceCan('authorization.create')" type="button" @click="openGrant(item)">数据授权</button>
          <button v-else-if="workspaceCan('authorization.request')" type="button" @click="openGrant(item)">申请授权</button>
          <button type="button" @click="activePanel = 'mine'">查看授权</button>
        </span>
      </article>
    </div>
  </section>
</template>
