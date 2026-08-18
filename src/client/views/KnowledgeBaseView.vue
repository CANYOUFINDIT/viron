<script setup lang="ts">
import { BookOpen } from "@lucide/vue";
import KnowledgeBasePanel from "../components/KnowledgeBasePanel.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <div class="knowledge-base-view">
    <PageHeader :title="$t('知识库')">
      <template #actions>
        <span class="knowledge-base-view__scope"><BookOpen :size="15" />{{ $t('当前工作区的全部文档') }}</span>
      </template>
    </PageHeader>
    <KnowledgeBasePanel />
  </div>
</template>

<style scoped>
.knowledge-base-view { height: var(--workbench-viewport-height, calc(100dvh - 32px)); min-height: 520px; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.knowledge-base-view :deep(.page-header) { margin-block-end: 12px; }
.knowledge-base-view__scope { min-height: 30px; padding: 0 10px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); color: var(--ink-500); display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; }
@media (max-width: 820px) { .knowledge-base-view { min-height: 480px; } }
</style>
