<script setup lang="ts">
import { AlertTriangle, RefreshCw } from "@lucide/vue";

defineProps<{
  title?: string;
  message?: string;
}>();

defineEmits<{
  reload: [];
}>();
</script>

<template>
  <section class="route-error-state" role="alert">
    <span class="route-error-state__icon"><AlertTriangle :size="26" /></span>
    <h2>{{ title || $t('页面加载失败') }}</h2>
    <p>{{ message || $t('请重新加载页面后再试。') }}</p>
    <el-button type="primary" @click="$emit('reload')"><RefreshCw :size="15" />{{ $t('重新加载') }}</el-button>
  </section>
</template>

<style scoped>
.route-error-state {
  min-height: 380px;
  padding: 42px 24px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 11px;
  text-align: center;
}

.route-error-state__icon {
  width: 58px;
  height: 58px;
  border-radius: var(--radius-control);
  background: var(--red-100);
  color: var(--red-600);
  display: grid;
  place-items: center;
}

.route-error-state h2 {
  margin: 6px 0 0;
  color: var(--color-ink);
  font-size: var(--text-lg);
}

.route-error-state p {
  max-width: 560px;
  margin: 0 0 8px;
  color: var(--color-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}
</style>
