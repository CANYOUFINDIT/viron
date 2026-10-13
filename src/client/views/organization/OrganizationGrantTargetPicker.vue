<script setup lang="ts">
import { resourceKey, type ResourceType } from "../../../shared/organization-rbac";
import {
  applicationEnvironmentState,
  catalogLabel,
  linkedResources,
  toggleApplicationEnvironment,
  toggleResource,
  type NamedCatalogItem,
} from "./grant-selection";

const props = defineProps<{
  modelValue: Array<{ type: ResourceType; id: string }>;
  catalog: NamedCatalogItem[];
  query: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [Array<{ type: ResourceType; id: string }>];
  "update:query": [string];
}>();
const sections: Array<[ResourceType, string]> = [
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
];

function visible(name: string) {
  const query = props.query.trim().toLowerCase();
  return !query || name.toLowerCase().includes(query);
}
function checked(target: { type: ResourceType; id: string }) {
  return props.modelValue.some((item) => resourceKey(item) === resourceKey(target));
}
function state(environmentId: string) {
  return applicationEnvironmentState(props.catalog, props.modelValue, environmentId);
}
</script>

<template>
  <div class="mine-picker">
    <el-input :model-value="query" clearable placeholder="按名称筛选" @update:model-value="emit('update:query', String($event))" />
    <div>
      <h5>按环境批选</h5>
      <el-checkbox
        v-for="environment in catalog.filter((item) => item.type === 'environment' && visible(item.name))"
        :key="environment.id"
        :model-value="state(environment.id) === 'on' || state(environment.id) === 'empty-on'"
        :indeterminate="state(environment.id) === 'partial'"
        @change="emit('update:modelValue', toggleApplicationEnvironment(catalog, modelValue, environment.id, $event === true))"
      >
        {{ environment.name }}
        <small>{{ state(environment.id) === "empty" || state(environment.id) === "empty-on" ? "空环境，保留环境目标" : `当前 ${linkedResources(catalog, environment.id).length} 个关联资源` }}</small>
      </el-checkbox>
    </div>
    <div v-for="section in sections" :key="section[0]">
      <h5>{{ section[1] }}</h5>
      <el-checkbox
        v-for="item in catalog.filter((entry) => entry.type === section[0] && visible(entry.name))"
        :key="resourceKey(item)"
        :model-value="checked(item)"
        @change="emit('update:modelValue', toggleResource(modelValue, item, $event === true))"
      >
        {{ item.name }}
        <small v-if="!item.environmentIds.length">独立</small>
      </el-checkbox>
    </div>
    <div>
      <h5>实际固定目标</h5>
      <p v-for="target in modelValue" :key="resourceKey(target)">{{ catalogLabel(catalog, target) }}</p>
      <p v-if="!modelValue.length">还没有选择目标</p>
    </div>
  </div>
</template>

<style scoped>
.mine-picker { display: grid; gap: 8px; max-height: 420px; overflow: auto; }
h5 { margin: 8px 0 4px; font-size: 12px; }
small { margin-left: 6px; color: var(--el-text-color-secondary); }
</style>
