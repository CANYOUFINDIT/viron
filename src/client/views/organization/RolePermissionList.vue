<script setup lang="ts">
import { computed, ref } from "vue";
import { Check } from "@lucide/vue";
import { PERMISSION_DEFINITIONS } from "../../../shared/organization-rbac";
const props = defineProps<{ codes: string[] }>();
const showCodes = ref(false);
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
const permissionCount = computed(() => groups.value.reduce((count, group) => count + group.items.length, 0));
</script>
<template>
  <div class="permission-summary" aria-label="角色操作权限（只读）">
    <header v-if="groups.length" class="permission-summary__toolbar">
      <p>共 {{ permissionCount }} 项操作 · {{ groups.length }} 个分组</p>
      <el-checkbox v-model="showCodes">显示权限码</el-checkbox>
    </header>
    <section v-for="group in groups" :key="group.module" class="permission-summary__group" :aria-label="group.module">
      <header class="permission-summary__heading">
        <h4>{{ group.module }}</h4>
        <span>{{ group.items.length }} 项</span>
      </header>
      <ul class="permission-summary__items">
        <li v-for="item in group.items" :key="item.code" class="permission-summary__item">
          <Check :size="14" aria-hidden="true" />
          <div>
            <span>{{ item.label }}</span>
            <code v-if="showCodes">{{ item.code }}</code>
          </div>
        </li>
      </ul>
    </section>
    <p v-if="!groups.length" class="permission-summary__empty">此角色没有操作权限</p>
  </div>
</template>
<style scoped>
.permission-summary {
  min-width: 0;
  font-size: 12px;
}
.permission-summary__toolbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  padding-bottom: 12px;
  color: var(--el-text-color-secondary);
}
.permission-summary__toolbar p {
  margin: 0;
}
.permission-summary__toolbar :deep(.el-checkbox) {
  height: 24px;
  margin: 0;
}
.permission-summary__toolbar :deep(.el-checkbox__label) {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.permission-summary__group {
  padding: 16px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}
.permission-summary__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.permission-summary__heading h4 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}
.permission-summary__heading > span {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.permission-summary__items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 12px 24px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.permission-summary__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  color: var(--el-text-color-primary);
  line-height: 1.6;
}
.permission-summary__item > svg {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--el-color-primary);
}
.permission-summary__item > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.permission-summary__item code {
  display: block;
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.permission-summary__empty {
  margin: 0;
  padding: 24px 0;
  color: var(--el-text-color-secondary);
}
</style>
