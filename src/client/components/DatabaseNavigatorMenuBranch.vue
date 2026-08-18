<script setup lang="ts">
import { ChevronRight } from "@lucide/vue";
import type { DatabaseNavigatorMenuItem } from "../database-navigator-menu";

defineOptions({ name: "DatabaseNavigatorMenuBranch" });

defineProps<{
  items: DatabaseNavigatorMenuItem[];
  parentKey?: string;
}>();

const emit = defineEmits<{ select: [key: string] }>();
</script>

<template>
  <div
    v-for="item in items"
    :key="item.key"
    class="database-navigator-menu__row"
    :class="{ 'is-separated': item.separated }"
  >
    <button
      class="database-navigator-menu__item"
      :class="{ 'is-danger': item.danger }"
      type="button"
      role="menuitem"
      :data-action="item.key"
      :data-parent-action="parentKey"
      :disabled="item.disabled"
      :title="item.disabled ? item.reason : undefined"
      :aria-haspopup="item.children?.length ? 'menu' : undefined"
      @click="item.children?.length ? undefined : emit('select', item.key)"
    >
      <span>{{ item.label }}</span>
      <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
      <ChevronRight v-if="item.children?.length" :size="14" :stroke-width="2" />
    </button>
    <div v-if="item.children?.length" class="database-navigator-menu__submenu" role="menu" :aria-label="item.label">
      <DatabaseNavigatorMenuBranch :items="item.children" :parent-key="item.key" @select="emit('select', $event)" />
    </div>
  </div>
</template>
