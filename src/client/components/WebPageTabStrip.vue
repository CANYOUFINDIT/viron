<script setup lang="ts">import { translate as tr } from "../i18n";

import { Globe2, LoaderCircle, Plus, X } from "@lucide/vue";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { reorderIds, sameOrder } from "../../shared/tab-order";

interface WebPageTab {
  id: string;
  title: string;
  url?: string;
  loading?: boolean;
}

const props = defineProps<{
  pages: WebPageTab[];
  activePageId: string;
}>();

const emit = defineEmits<{
  activate: [pageId: string];
  close: [pageId: string];
  create: [];
  reorder: [orderedPageIds: string[]];
}>();

const tabList = ref<HTMLElement | null>(null);
const draggingPageId = ref("");
const dropTarget = ref<{ id: string; after: boolean } | null>(null);
let resizeObserver: ResizeObserver | null = null;

function pageTitle(page: WebPageTab) {
  return page.title.trim() || tr("新页面");
}

function keepActiveTabVisible() {
  const list = tabList.value;
  if (!list) return;
  const active = [...list.querySelectorAll<HTMLElement>("[data-page-id]")]
    .find((element) => element.dataset.pageId === props.activePageId);
  if (!active) return;
  const left = active.offsetLeft;
  const right = left + active.offsetWidth;
  if (left < list.scrollLeft) list.scrollTo({ left: Math.max(0, left - 8), behavior: "smooth" });
  else if (right > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right - list.clientWidth + 8, behavior: "smooth" });
}

function insertAfterTarget(event: DragEvent): boolean {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return false;
  const bounds = element.getBoundingClientRect();
  return event.clientX > bounds.left + bounds.width / 2;
}

function startDrag(pageId: string, event: DragEvent) {
  draggingPageId.value = pageId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `web-page:${pageId}`);
  }
}

function dragOver(pageId: string, event: DragEvent) {
  if (!draggingPageId.value || draggingPageId.value === pageId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = { id: pageId, after: insertAfterTarget(event) };
}

function dragLeave(pageId: string, event: DragEvent) {
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(nextTarget)) return;
  if (dropTarget.value?.id === pageId) dropTarget.value = null;
}

function drop(pageId: string, event: DragEvent) {
  if (!draggingPageId.value) return;
  event.preventDefault();
  const currentIds = props.pages.map((page) => page.id);
  const orderedPageIds = reorderIds(currentIds, draggingPageId.value, pageId, insertAfterTarget(event));
  draggingPageId.value = "";
  dropTarget.value = null;
  if (!sameOrder(currentIds, orderedPageIds)) emit("reorder", orderedPageIds);
}

function endDrag() {
  draggingPageId.value = "";
  dropTarget.value = null;
}

watch(
  () => [props.activePageId, props.pages.length],
  async () => {
    await nextTick();
    keepActiveTabVisible();
  },
);

onMounted(() => {
  keepActiveTabVisible();
  resizeObserver = new ResizeObserver(keepActiveTabVisible);
  if (tabList.value) resizeObserver.observe(tabList.value);
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <nav v-show="pages.length > 1" class="web-page-tabs" :aria-label="$t('当前账号的页面标签')">
    <div ref="tabList" class="web-page-tabs__list" role="tablist" aria-orientation="horizontal">
      <div
        v-for="page in pages"
        :key="page.id"
        class="web-page-tab"
        :class="{
          'is-active': page.id === activePageId,
          'is-dragging': page.id === draggingPageId,
          'is-drop-before': dropTarget?.id === page.id && !dropTarget.after,
          'is-drop-after': dropTarget?.id === page.id && dropTarget.after,
        }"
        :data-page-id="page.id"
        @dragover="dragOver(page.id, $event)"
        @dragleave="dragLeave(page.id, $event)"
        @drop="drop(page.id, $event)"
      >
        <button
          class="web-page-tab__main"
          type="button"
          role="tab"
          draggable="true"
          :aria-selected="page.id === activePageId"
          :title="page.url || pageTitle(page)"
          @click="emit('activate', page.id)"
          @dragstart="startDrag(page.id, $event)"
          @dragend="endDrag"
        >
          <LoaderCircle v-if="page.loading" :size="13" class="is-spinning" />
          <Globe2 v-else :size="13" />
          <span>{{ pageTitle(page) }}</span>
        </button>
        <button
          v-if="pages.length > 1"
          class="web-page-tab__close"
          type="button"
          :aria-label="$t('关闭页面：{0}', [pageTitle(page)])"
          :title="$t('关闭 {0}', [pageTitle(page)])"
          @click="emit('close', page.id)"
        >
          <X :size="13" />
        </button>
      </div>
      <button class="web-page-tabs__add" type="button" :aria-label="$t('新建空白标签页')" :title="$t('新建空白标签页')" @click="emit('create')">
        <span><Plus :size="17" /></span>
      </button>
    </div>
  </nav>
</template>
