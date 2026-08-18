<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DatabaseNavigatorMenuItem } from "../database-navigator-menu";
import DatabaseNavigatorMenuBranch from "./DatabaseNavigatorMenuBranch.vue";

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
  items: DatabaseNavigatorMenuItem[];
}>();
const emit = defineEmits<{ close: []; select: [key: string] }>();

const menu = ref<HTMLElement | null>(null);
const position = ref({ x: 0, y: 0 });
const opensLeft = computed(() => position.value.x > window.innerWidth - 510);
const menuStyle = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }));

function enabledButtons(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>(".database-navigator-menu__item:not(:disabled)") ?? [])]
    .filter((button) => button.offsetParent !== null);
}

function focusRelative(delta: number) {
  const buttons = enabledButtons();
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(index + delta + buttons.length) % buttons.length]?.focus();
}

function selectItem(key: string) {
  emit("select", key);
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (!props.visible) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusRelative(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "ArrowRight") {
    const button = document.activeElement as HTMLButtonElement | null;
    const submenu = button?.closest(".database-navigator-menu__row")?.querySelector<HTMLElement>(":scope > .database-navigator-menu__submenu");
    const child = submenu?.querySelector<HTMLButtonElement>(".database-navigator-menu__item:not(:disabled)");
    if (child) {
      event.preventDefault();
      child.focus();
    }
  } else if (event.key === "ArrowLeft") {
    const button = document.activeElement as HTMLButtonElement | null;
    const submenu = button?.closest<HTMLElement>(".database-navigator-menu__submenu");
    const parent = submenu?.parentElement?.querySelector<HTMLButtonElement>(":scope > .database-navigator-menu__item");
    if (parent) {
      event.preventDefault();
      parent.focus();
    }
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (props.visible && !menu.value?.contains(event.target as Node)) emit("close");
}

function closeForViewportChange() {
  if (props.visible) emit("close");
}

watch(() => props.visible, async (visible) => {
  if (!visible) return;
  position.value = { x: props.x, y: props.y };
  await nextTick();
  const bounds = menu.value?.getBoundingClientRect();
  if (bounds) {
    position.value = {
      x: Math.max(8, Math.min(props.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(props.y, window.innerHeight - bounds.height - 8)),
    };
  }
  await nextTick();
  enabledButtons()[0]?.focus();
});

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", closeForViewportChange);
  window.addEventListener("blur", closeForViewportChange);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", closeForViewportChange);
  window.removeEventListener("blur", closeForViewportChange);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menu"
      class="database-navigator-menu"
      :class="{ 'opens-left': opensLeft }"
      :style="menuStyle"
      role="menu"
      :aria-label="$t('数据库对象操作')"
      @contextmenu.prevent
    >
      <DatabaseNavigatorMenuBranch :items="items" @select="selectItem" />
    </div>
  </Teleport>
</template>
