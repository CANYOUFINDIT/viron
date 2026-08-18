<script setup lang="ts">
import { CircleHelp } from "@lucide/vue";

withDefaults(defineProps<{
  content: string;
  placement?: "top" | "top-start" | "top-end" | "bottom" | "bottom-start" | "bottom-end" | "left" | "right";
}>(), {
  placement: "top",
});
</script>

<template>
  <el-tooltip :content="content" :placement="placement" :show-after="700" popper-class="viron-tip-popper">
    <button class="tip-icon" type="button" :aria-label="$t('提示：{0}', [content])" @click.stop.prevent>
      <CircleHelp :size="15" />
    </button>
  </el-tooltip>
</template>

<style scoped>
.tip-icon {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-muted);
  display: grid;
  place-items: center;
  cursor: help;
  transition: background-color var(--dur-micro) ease, color var(--dur-micro) ease;
}

.tip-icon:hover {
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
}

.tip-icon:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.tip-icon:active { background: var(--color-paper-muted); }
</style>
