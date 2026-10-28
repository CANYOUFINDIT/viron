<script setup lang="ts">
import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RefreshCw, ShieldCheck, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { normalizeWebAddress } from "../../shared/web-address";
import { DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT, type DesktopWebPopupAction, type DesktopWebPopupState } from "../../shared/web-popup";
import { translate as tr } from "../i18n";

const emptyState: DesktopWebPopupState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  secure: false,
};

const state = ref<DesktopWebPopupState>(emptyState);
const address = ref("");
const editing = ref(false);
const invalid = ref(false);
const toolbarHeight = `${DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT}px`;
let stopState: (() => void) | null = null;
let stopFocus: (() => void) | null = null;
let resetInvalid: number | undefined;

const secure = computed(() => state.value.secure && state.value.url.startsWith("https://"));

function applyState(next: DesktopWebPopupState) {
  state.value = next;
  if (!editing.value) address.value = next.url;
}

function beginEdit(event: FocusEvent) {
  editing.value = true;
  address.value = state.value.url;
  invalid.value = false;
  if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.select();
}

function endEdit() {
  editing.value = false;
  address.value = state.value.url;
}

async function run(action: DesktopWebPopupAction) {
  try {
    await window.vironWebPopup?.action(action);
  } catch (error) {
    invalid.value = true;
    window.clearTimeout(resetInvalid);
    resetInvalid = window.setTimeout(() => { invalid.value = false; }, 1600);
    console.error("[Viron] Web popup action failed", error);
  }
}

function navigate() {
  const url = normalizeWebAddress(address.value);
  if (!url) {
    invalid.value = true;
    window.clearTimeout(resetInvalid);
    resetInvalid = window.setTimeout(() => { invalid.value = false; }, 1600);
    return;
  }
  editing.value = false;
  address.value = url;
  void run({ type: "navigate", url });
}

function focusAddress() {
  const input = document.querySelector<HTMLInputElement>(".web-popup-address input");
  input?.focus();
  input?.select();
}

onMounted(async () => {
  stopState = window.vironWebPopup?.onState(applyState) ?? null;
  stopFocus = window.vironWebPopup?.onFocusAddress(focusAddress) ?? null;
  try {
    const initial = await window.vironWebPopup?.getState();
    if (initial) applyState(initial);
  } catch {
    // The target may already be gone while the shell is closing.
  }
});

onBeforeUnmount(() => {
  stopState?.();
  stopFocus?.();
  window.clearTimeout(resetInvalid);
});
</script>

<template>
  <section class="web-popup-chrome" :style="{ '--web-popup-toolbar-height': toolbarHeight }">
    <header class="web-popup-toolbar">
      <div class="web-popup-nav">
        <button type="button" :aria-label="tr('后退')" :title="tr('后退')" :disabled="!state.canGoBack" @click="run({ type: 'back' })"><ArrowLeft :size="16" /></button>
        <button type="button" :aria-label="tr('前进')" :title="tr('前进')" :disabled="!state.canGoForward" @click="run({ type: 'forward' })"><ArrowRight :size="16" /></button>
        <button type="button" :aria-label="state.loading ? tr('停止加载') : tr('刷新')" :title="state.loading ? tr('停止加载') : tr('刷新')" @click="run({ type: state.loading ? 'stop' : 'reload' })">
          <X v-if="state.loading" :size="16" />
          <RefreshCw v-else :size="16" />
        </button>
      </div>
      <form class="web-popup-address" :class="{ 'is-invalid': invalid }" @submit.prevent="navigate">
        <ShieldCheck v-if="secure" :size="14" class="is-secure" />
        <Globe2 v-else :size="14" />
        <input
          v-model="address"
          :aria-label="tr('页面地址')"
          :placeholder="tr('输入网址')"
          autocomplete="off"
          spellcheck="false"
          @focus="beginEdit"
          @blur="endEdit"
        />
        <LoaderCircle v-if="state.loading" :size="14" class="is-spinning" />
      </form>
      <div class="web-popup-actions">
        <button type="button" :aria-label="tr('关闭窗口')" :title="tr('关闭窗口')" @click="run({ type: 'close' })"><X :size="16" /></button>
      </div>
    </header>
  </section>
</template>

<style scoped>
.web-popup-chrome {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #f7f9f8;
  color: #243832;
  font-family: "Avenir Next", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  user-select: none;
}
.web-popup-toolbar {
  box-sizing: border-box;
  height: var(--web-popup-toolbar-height);
  padding: 0 8px;
  border-bottom: 1px solid #d5dfdc;
  background: #eef3f1;
  display: grid;
  grid-template-columns: auto minmax(120px, 1fr) auto;
  align-items: center;
  gap: 8px;
  -webkit-app-region: drag;
}
.web-popup-nav,
.web-popup-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}
.web-popup-toolbar button {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #51635e;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.web-popup-toolbar button:hover:not(:disabled) {
  border-color: #c9d6d2;
  background: #f7faf9;
  color: #157a64;
}
.web-popup-toolbar button:disabled {
  opacity: 0.34;
  cursor: not-allowed;
}
.web-popup-address {
  box-sizing: border-box;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  border: 1px solid #c8d5d1;
  border-radius: 7px;
  background: #ffffff;
  display: flex;
  align-items: center;
  gap: 7px;
  -webkit-app-region: no-drag;
}
.web-popup-address:focus-within {
  border-color: #1b8a72;
  box-shadow: 0 0 0 2px rgba(27, 138, 114, 0.14);
}
.web-popup-address.is-invalid {
  border-color: #c8544a;
  box-shadow: 0 0 0 2px rgba(200, 84, 74, 0.12);
}
.web-popup-address svg {
  flex: none;
  color: #7b8c87;
}
.web-popup-address svg.is-secure {
  color: #16806a;
}
.web-popup-address input {
  min-width: 0;
  width: 100%;
  flex: 1;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #2b3f39;
  font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 11.5px;
  user-select: text;
}
.web-popup-address input::placeholder {
  color: #9aa8a4;
}
.is-spinning {
  animation: web-popup-spin 0.9s linear infinite;
}
@keyframes web-popup-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-color-scheme: dark) {
  .web-popup-chrome { background: #101a18; color: #dce8e4; }
  .web-popup-toolbar { border-bottom-color: #2a3a36; background: #17231f; }
  .web-popup-toolbar button { color: #a9bbb4; }
  .web-popup-toolbar button:hover:not(:disabled) { border-color: #3b4f49; background: #21302b; color: #6cd6b5; }
  .web-popup-address { border-color: #344741; background: #0e1715; }
  .web-popup-address input { color: #dce8e4; }
  .web-popup-address input::placeholder { color: #6f817b; }
  .web-popup-address svg { color: #8da19a; }
  .web-popup-address svg.is-secure { color: #6cd6b5; }
}
</style>
