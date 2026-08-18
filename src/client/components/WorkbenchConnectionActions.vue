<script setup lang="ts">
import type { Component } from "vue";

defineProps<{
  actions: Array<{
    key: string;
    label: string;
    icon: Component;
    disabled?: boolean;
    divided?: boolean;
    danger?: boolean;
  }>;
}>();
</script>

<template>
  <el-dropdown-menu class="workbench-connection-actions">
    <el-dropdown-item
      v-for="action in actions"
      :key="action.key"
      :command="action.key"
      :disabled="action.disabled"
      :divided="action.divided"
      :class="{ 'workbench-connection-action--danger': action.danger }"
    >
      <component :is="action.icon" :size="15" :stroke-width="1.8" aria-hidden="true" />{{ action.label }}
    </el-dropdown-item>
  </el-dropdown-menu>
</template>
