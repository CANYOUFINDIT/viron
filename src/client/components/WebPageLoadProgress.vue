<script setup lang="ts">
defineProps<{ loading: boolean }>();
</script>

<template>
  <span v-if="loading" class="web-page-load-progress" role="progressbar" :aria-label="$t('网页加载中')" :title="$t('网页加载中')">
    <span />
  </span>
</template>

<style scoped>
.web-page-load-progress { position: absolute; inset: auto 4px -1px; height: 2px; overflow: hidden; border-radius: 2px; pointer-events: none; background: color-mix(in srgb, var(--color-accent-strong) 15%, transparent); }
.web-page-load-progress > span { display: block; width: 36%; height: 100%; background: var(--color-accent-strong); animation: web-page-loading 1.25s ease-in-out infinite; }
@keyframes web-page-loading { from { transform: translateX(-100%); } to { transform: translateX(380%); } }
@media (prefers-reduced-motion: reduce) { .web-page-load-progress > span { animation: none; width: 100%; opacity: .65; } }
</style>
