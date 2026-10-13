<script setup lang="ts">
import { computed } from "vue";
import { PERMISSION_DEFINITIONS } from "../../../shared/organization-rbac";
const props = defineProps<{ codes: string[] }>();
const groups = computed(() =>
  [...new Set(PERMISSION_DEFINITIONS.map((p) => p.module))]
    .map((module) => ({
      module,
      items: PERMISSION_DEFINITIONS.filter(
        (p) => p.module === module && props.codes.includes(p.code),
      ),
    }))
    .filter((g) => g.items.length),
);
</script>
<template>
  <div class="permission-summary" aria-label="角色操作权限（只读）">
    <div v-for="group in groups" :key="group.module">
      <strong>{{ group.module }}</strong
      ><span v-for="item in group.items" :key="item.code"
        >✓ {{ item.label }} <code>{{ item.code }}</code></span
      >
    </div>
    <p v-if="!groups.length">此角色没有操作权限</p>
  </div>
</template>
<style scoped>
.permission-summary {
  display: grid;
  gap: 12px;
  font-size: 12px;
  padding: 16px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.permission-summary > div {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.permission-summary strong {
  width: 92px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
}
.permission-summary span {
  color: var(--el-text-color-regular);
}
.permission-summary code {
  margin-left: 4px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.permission-summary p {
  margin: 0;
}
</style>
