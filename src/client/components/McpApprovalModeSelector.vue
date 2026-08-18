<script setup lang="ts">
import { Check, Hand, ShieldCheck, Zap } from "@lucide/vue";
import type { Component } from "vue";
import type { McpApprovalMode } from "../../shared/mcp-settings";

withDefaults(defineProps<{
  modelValue: McpApprovalMode;
  disabled?: boolean;
  compact?: boolean;
}>(), {
  disabled: false,
  compact: false,
});

const emit = defineEmits<{ "update:modelValue": [value: McpApprovalMode] }>();

const modes: Array<{
  value: McpApprovalMode;
  title: string;
  description: string;
  icon: Component;
  tone: string;
}> = [
  {
    value: "always",
    title: "请求批准",
    description: "每个需要 Viron 确认的执行操作都询问",
    icon: Hand,
    tone: "manual",
  },
  {
    value: "high-risk",
    title: "替我审批",
    description: "中风险操作自动通过，高风险操作仍询问",
    icon: ShieldCheck,
    tone: "guarded",
  },
  {
    value: "never",
    title: "完全访问权限",
    description: "风险操作直接执行，不再显示审批弹窗",
    icon: Zap,
    tone: "full",
  },
];
</script>

<template>
  <div class="mcp-approval-selector" :class="{ 'is-compact': compact }" role="radiogroup" :aria-label="$t('MCP 审批策略')">
    <button
      v-for="mode in modes"
      :key="mode.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === mode.value"
      :disabled="disabled"
      :class="[`is-${mode.tone}`, { 'is-selected': modelValue === mode.value }]"
      @click="emit('update:modelValue', mode.value)"
    >
      <span class="mode-icon"><component :is="mode.icon" :size="compact ? 15 : 18" /></span>
      <span class="mode-copy"><strong>{{ $t(mode.title) }}</strong><small>{{ $t(mode.description) }}</small></span>
      <span v-if="modelValue === mode.value" class="mode-check"><Check :size="14" /></span>
    </button>
  </div>
</template>

<style scoped>
.mcp-approval-selector { display: grid; gap: 8px; }
.mcp-approval-selector button { width: 100%; min-height: 66px; padding: 11px 12px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--surface); color: var(--ink-600); display: grid; grid-template-columns: 34px minmax(0, 1fr) 22px; align-items: center; gap: 10px; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease; }
.mcp-approval-selector button:hover:not(:disabled) { border-color: var(--ink-200); background: var(--ink-50); transform: translateY(-1px); }
.mcp-approval-selector button:focus-visible { outline: 2px solid var(--teal-500); outline-offset: 2px; }
.mcp-approval-selector button:disabled { cursor: not-allowed; opacity: .58; }
.mode-icon { width: 34px; height: 34px; border-radius: 9px; background: var(--ink-50); color: var(--ink-500); display: grid; place-items: center; }
.mode-copy strong, .mode-copy small { display: block; }
.mode-copy strong { color: var(--ink-700); font-size: 12px; }
.mode-copy small { margin-top: 3px; color: var(--ink-400); font-size: 10px; line-height: 1.45; }
.mode-check { width: 22px; height: 22px; border-radius: 50%; background: var(--teal-600); color: #fff; display: grid; place-items: center; }
.mcp-approval-selector button.is-selected { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal-500) 8%, transparent); }
.mcp-approval-selector button.is-selected .mode-icon { background: var(--surface); color: var(--teal-700); }
.mcp-approval-selector button.is-full.is-selected { border-color: color-mix(in srgb, var(--orange-500, #e96f32) 58%, var(--ink-100)); background: color-mix(in srgb, var(--orange-500, #e96f32) 9%, var(--surface)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange-500, #e96f32) 8%, transparent); }
.mcp-approval-selector button.is-full.is-selected .mode-icon { color: var(--orange-600, #b84d20); }
.mcp-approval-selector button.is-full.is-selected .mode-check { background: var(--orange-600, #c45a27); }
.mcp-approval-selector.is-compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.mcp-approval-selector.is-compact button { min-height: 58px; padding: 9px; grid-template-columns: 26px minmax(0, 1fr) 18px; gap: 7px; }
.mcp-approval-selector.is-compact .mode-icon { width: 26px; height: 26px; border-radius: 7px; }
.mcp-approval-selector.is-compact .mode-copy strong { font-size: 10px; }
.mcp-approval-selector.is-compact .mode-copy small { display: none; }
.mcp-approval-selector.is-compact .mode-check { width: 18px; height: 18px; }
@media (max-width: 720px) {
  .mcp-approval-selector.is-compact { grid-template-columns: 1fr; }
  .mcp-approval-selector.is-compact .mode-copy small { display: block; }
}
</style>
