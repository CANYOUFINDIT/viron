<script setup lang="ts">
import { X } from "@lucide/vue";
import { ref, watch } from "vue";
import type { WebLoginMode } from "../../shared/protected-web-login";
const props = defineProps<{ message?: string; mode?: WebLoginMode }>();
defineEmits<{ retry: [] }>();
const dismissed = ref(false);
watch(() => props.message, () => { dismissed.value = false; });
</script>

<template>
  <div v-if="message && !dismissed" class="web-login-notice" role="status">
    <span>{{ message }}</span>
    <button type="button" @click="$emit('retry')">{{ $t('重新填充') }}</button>
    <button type="button" class="web-login-notice__close" :aria-label="$t('关闭提示')" @click="dismissed = true"><X :size="14" /></button>
  </div>
</template>

<style scoped>
.web-login-notice { display: flex; align-items: center; gap: 12px; flex: none; padding: 8px 12px; border-bottom: 1px solid var(--ink-100); background: var(--surface, #fff); color: var(--ink-600); font-size: 12px; line-height: 1.5; }
.web-login-notice span { flex: 1; min-width: 0; }
.web-login-notice button { flex: none; border: 0; padding: 4px; background: transparent; color: var(--teal-600); cursor: pointer; }
.web-login-notice__close { display: flex; align-items: center; }
</style>
