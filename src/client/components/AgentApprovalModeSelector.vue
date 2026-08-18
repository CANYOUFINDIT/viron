<script setup lang="ts">
import { Check, Hand, ShieldCheck, Zap } from "@lucide/vue";
import type { Component } from "vue";
import type { AgentApprovalMode } from "../../shared/agent";

defineProps<{
  modelValue: AgentApprovalMode;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: AgentApprovalMode] }>();

const modes: Array<{
  value: AgentApprovalMode;
  title: string;
  description: string;
  icon: Component;
  tone: string;
}> = [
  {
    value: "always",
    title: "请求批准",
    description: "每个执行动作都在对话卡片中询问一次",
    icon: Hand,
    tone: "manual",
  },
  {
    value: "risk-only",
    title: "帮我批准",
    description: "已证明为低风险的动作自动执行，其他动作仍询问",
    icon: ShieldCheck,
    tone: "guarded",
  },
  {
    value: "never",
    title: "完全访问权限",
    description: "已实现并启用的动作自动执行，仍受 Viron 权限与工具策略限制",
    icon: Zap,
    tone: "full",
  },
];
</script>

<template>
  <div class="agent-approval-selector" role="radiogroup" :aria-label="$t('Viron Agent 审批策略')">
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
      <span class="mode-icon"><component :is="mode.icon" :size="18" /></span>
      <span class="mode-copy"><strong>{{ $t(mode.title) }}</strong><small>{{ $t(mode.description) }}</small></span>
      <span v-if="modelValue === mode.value" class="mode-check"><Check :size="14" /></span>
    </button>
  </div>
</template>

<style scoped>
.agent-approval-selector { display: grid; gap: 8px; }
.agent-approval-selector button { width: 100%; min-height: 66px; padding: 11px 12px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); color: var(--ink-600); display: grid; grid-template-columns: 34px minmax(0, 1fr) 22px; align-items: center; gap: 10px; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.agent-approval-selector button:hover:not(:disabled) { border-color: var(--ink-200); background: var(--ink-50); }
.agent-approval-selector button:focus-visible { outline: 2px solid var(--teal-500); outline-offset: 2px; }
.agent-approval-selector button:disabled { cursor: not-allowed; opacity: .58; }
.mode-icon { width: 34px; height: 34px; border-radius: 8px; background: var(--ink-50); color: var(--ink-500); display: grid; place-items: center; }
.mode-copy strong, .mode-copy small { display: block; }
.mode-copy strong { color: var(--ink-700); font-size: 12px; }
.mode-copy small { margin-top: 3px; color: var(--ink-400); font-size: 10px; line-height: 1.45; }
.mode-check { width: 22px; height: 22px; border-radius: 50%; background: var(--teal-600); color: #fff; display: grid; place-items: center; }
.agent-approval-selector button.is-selected { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal-500) 8%, transparent); }
.agent-approval-selector button.is-selected .mode-icon { background: var(--surface); color: var(--teal-700); }
.agent-approval-selector button.is-full.is-selected { border-color: color-mix(in srgb, var(--orange-500, #e96f32) 58%, var(--ink-100)); background: color-mix(in srgb, var(--orange-500, #e96f32) 9%, var(--surface)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange-500, #e96f32) 8%, transparent); }
.agent-approval-selector button.is-full.is-selected .mode-icon { color: var(--orange-600, #b84d20); }
.agent-approval-selector button.is-full.is-selected .mode-check { background: var(--orange-600, #c45a27); }
</style>
