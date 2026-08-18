<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <header class="page-header">
    <h1>{{ title }}</h1>
    <div v-if="$slots.actions" class="page-header__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
/* Hallmark · shared page header · genre: modern-minimal · theme: Viron Workbench · contrast: pass */
.page-header {
  min-width: 0;
  min-height: 44px;
  margin-block-end: var(--space-lg);
  padding: 0;
  color: var(--color-ink);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-lg);
}

.page-header h1 {
  min-width: 0;
  margin: 0;
  color: var(--color-ink);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-style: normal;
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.page-header__actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.page-header__actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
.page-header__actions :deep(.el-button),
.page-header__actions :deep(.el-dropdown) { white-space: nowrap; }

@media (max-width: 56.25rem) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .page-header__actions { width: 100%; justify-content: flex-start; }
}

@media (max-width: 40rem) {
  .page-header { min-height: 0; margin-block-end: var(--space-md); }
  .page-header__actions :deep(.el-button) { flex: 1 1 auto; }
}
</style>
