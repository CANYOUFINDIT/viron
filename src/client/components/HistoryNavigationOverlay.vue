<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HISTORY_NAVIGATION_SURFACE_SELECTOR } from "../../shared/history-navigation-gesture";
import { historyNavigationOverlay } from "../history-navigation";

const view = computed(() => historyNavigationOverlay.value);
const surface = ref({ left: 0, top: 0, width: 0, height: 0 });
let resizeObserver: ResizeObserver | null = null;

function measureSurface() {
  const element = document.querySelector(HISTORY_NAVIGATION_SURFACE_SELECTOR);
  if (!(element instanceof HTMLElement)) return;
  const rect = element.getBoundingClientRect();
  surface.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

onMounted(() => {
  measureSurface();
  const element = document.querySelector(HISTORY_NAVIGATION_SURFACE_SELECTOR);
  if (element instanceof HTMLElement) {
    resizeObserver = new ResizeObserver(measureSurface);
    resizeObserver.observe(element);
  }
  window.addEventListener("resize", measureSurface);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", measureSurface);
});

watch(view, (value) => { if (value) measureSurface(); });
</script>

<template>
  <Teleport to="body">
    <aside
      v-if="view && surface.width > 1 && surface.height > 1"
      class="history-navigation-overlay"
      :class="[`is-${view.direction}`, { 'is-unavailable': !view.available }]"
      :style="{
        '--progress': String(view.progress),
        left: `${surface.left}px`,
        top: `${surface.top}px`,
        width: `${surface.width}px`,
        height: `${surface.height}px`,
      }"
      aria-hidden="true"
    >
      <span class="history-navigation-handle" :aria-label="view.direction === 'back' ? $t('后退到上一页') : $t('前进到下一页')">
        <ChevronLeft v-if="view.direction === 'back'" :size="28" :stroke-width="2.6" />
        <ChevronRight v-else :size="28" :stroke-width="2.6" />
      </span>
    </aside>
  </Teleport>
</template>

<style scoped>
.history-navigation-overlay {
  position: fixed;
  z-index: 140;
  overflow: hidden;
  pointer-events: none;
}
.history-navigation-handle {
  position: absolute;
  top: 50%;
  width: 48px;
  height: 80px;
  margin-top: -40px;
  background: #5d9ad6;
  color: white;
  display: grid;
  place-items: center;
  box-shadow: 0 8px 22px rgba(18, 67, 112, .32);
  opacity: calc(.5 + .5 * var(--progress));
}
.is-unavailable .history-navigation-handle { opacity: calc(.28 + .3 * var(--progress)); }
.is-back .history-navigation-handle {
  left: 0;
  border-radius: 0 18px 18px 0;
  transform: translateX(calc(-100% + 100% * var(--progress)));
}
.is-forward .history-navigation-handle {
  right: 0;
  border-radius: 18px 0 0 18px;
  transform: translateX(calc(100% - 100% * var(--progress)));
}
@media (prefers-reduced-motion: reduce) {
  .history-navigation-handle { opacity: 1; }
  .is-back .history-navigation-handle, .is-forward .history-navigation-handle { transform: none; }
}
</style>
