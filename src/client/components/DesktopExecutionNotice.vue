<script setup lang="ts">import { translate as tr } from "../i18n";

import { Laptop, ShieldCheck } from "@lucide/vue";

withDefaults(defineProps<{
  capability: string;
  compact?: boolean;
  description?: string;
}>(), { compact: false, description: tr("请检查当前 Endpoint 的协议版本、连接模式与服务端能力配置。") });
</script>

<template>
  <section class="desktop-execution-notice" :class="{ 'is-compact': compact }">
    <div class="desktop-execution-notice__icon"><Laptop :size="30" /></div>
    <p>CONNECTION UNAVAILABLE</p>
    <h3>{{ capability }}{{ $t('不可用') }}</h3>
    <span><ShieldCheck :size="15" />{{ description }}</span>
  </section>
</template>

<style scoped>
.desktop-execution-notice { min-height: 420px; flex: 1; border: 1px solid var(--ink-100); border-radius: var(--radius-md); background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--ink-500); }
.desktop-execution-notice.is-compact { min-height: 100%; border: 0; border-radius: 0; }
.desktop-execution-notice__icon { width: 62px; height: 62px; margin-bottom: 18px; border-radius: 18px 18px 18px 6px; background: var(--teal-50); color: var(--teal-600); display: grid; place-items: center; }
.desktop-execution-notice p { margin: 0 0 8px; color: var(--teal-600); font-size: 11px; font-weight: 800; letter-spacing: .12em; }
.desktop-execution-notice h3 { margin: 0; color: var(--ink-800); font-size: 19px; }
.desktop-execution-notice span { max-width: 560px; margin-top: 12px; display: flex; align-items: center; gap: 7px; font-size: 13px; line-height: 1.6; }
</style>
