<script setup lang="ts">
import { LoaderCircle, ShieldCheck } from "@lucide/vue";
import { ref } from "vue";
import type { ProtectedLoginInput, ProtectedLoginState } from "../../shared/protected-web-login";
const props = defineProps<{ state: ProtectedLoginState; send: (input: ProtectedLoginInput) => Promise<void> }>();
defineEmits<{ retry: [] }>();
const inputError = ref("");
let queue = Promise.resolve();
let dragging = false;
let lastMove = 0;
function send(input: Omit<ProtectedLoginInput, "revision">) {
  queue = queue.then(async () => {
    if (props.state.phase !== "interactive") return;
    try { await props.send({ ...input, revision: props.state.revision }); inputError.value = ""; }
    catch { inputError.value = "验证画面或焦点已变化，请在最新画面中重试"; }
  });
}
function pointer(event: PointerEvent, type: "mouseDown" | "mouseUp" | "mouseMove") {
  if (event.button !== 0 && type !== "mouseMove") return;
  const target = event.currentTarget as HTMLImageElement;
  if (type === "mouseDown") { dragging = true; target.setPointerCapture(event.pointerId); target.focus(); }
  if (type === "mouseMove") {
    if (!dragging || Date.now() - lastMove < 70) return;
    lastMove = Date.now();
  }
  const box = target.getBoundingClientRect();
  const x = Math.max(0, Math.min(props.state.width - 1, (event.clientX - box.x) * props.state.width / box.width));
  const y = Math.max(0, Math.min(props.state.height - 1, (event.clientY - box.y) * props.state.height / box.height));
  send({ type, x, y });
  if (type === "mouseUp") dragging = false;
}
function key(event: KeyboardEvent) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.key.length === 1) send({ type: "text", text: event.key });
  else if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) send({ type: "key", key: event.key.replace("Arrow", "") });
}
function paste(event: ClipboardEvent) {
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text && text.length <= 256) send({ type: "text", text });
}
</script>

<template>
  <div class="protected-login" @pointerdown.stop @mousedown.stop>
    <ShieldCheck v-if="state.phase === 'failed' || state.phase === 'interactive'" :size="28" />
    <LoaderCircle v-else :size="28" class="is-spinning" />
    <strong>{{ state.phase === 'interactive' ? '完成登录验证' : state.phase === 'failed' ? '后台登录未完成' : '正在后台登录' }}</strong>
    <p>{{ state.message }}</p>
    <template v-if="state.phase === 'interactive' && state.image">
      <img class="protected-login__challenge" :src="state.image" :width="state.width" :height="state.height" alt="登录验证区域" tabindex="0" draggable="false"
        @pointerdown.prevent="pointer($event, 'mouseDown')" @pointerup.prevent="pointer($event, 'mouseUp')" @pointermove.prevent="pointer($event, 'mouseMove')"
        @pointercancel="pointer($event, 'mouseUp')" @keydown="key" @compositionend="send({ type: 'text', text: $event.data })" @paste="paste" @contextmenu.prevent />
      <small>点击画面中的验证码输入框后输入，或操作滑块。完成后点击继续。</small>
      <small v-if="inputError" class="protected-login__error">{{ inputError }}</small>
      <el-button type="primary" @click="send({ type: 'continue' })">继续登录</el-button>
    </template>
    <el-button v-if="state.phase === 'failed'" type="primary" @click="$emit('retry')">重新后台登录</el-button>
  </div>
</template>

<style scoped>
.protected-login { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 14px; padding: 24px; overflow: auto; background: var(--surface, #fff); color: var(--teal-600); }
.protected-login strong { color: var(--ink-800); font-size: 16px; }
.protected-login p, .protected-login small { margin: 0; max-width: 520px; text-align: center; color: var(--ink-500); line-height: 1.65; }
.protected-login__challenge { max-width: 100%; height: auto; flex: none; border: 1px solid var(--ink-100); border-radius: 8px; touch-action: none; }
.protected-login__challenge:focus { outline: 2px solid var(--teal-500); outline-offset: 3px; }
.protected-login .protected-login__error { color: var(--el-color-danger); }
</style>
