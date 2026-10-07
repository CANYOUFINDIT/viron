<script setup lang="ts">
import { LoaderCircle, ShieldCheck } from "@lucide/vue";
import { ref, watch } from "vue";
import type { ProtectedLoginInput, ProtectedLoginState } from "../../shared/protected-web-login";
const props = defineProps<{ state: ProtectedLoginState; send: (input: ProtectedLoginInput) => Promise<void> }>();
defineEmits<{ retry: []; browse: [] }>();
const inputError = ref("");
let queue = Promise.resolve();
let dragging = false;
let moved = false;
let start: { x: number; y: number; revision: string } | null = null;
let lastMove = 0;
const menu = ref<{ left: number; top: number; targetToken?: string; revision: string } | null>(null);
function coordinates(event: MouseEvent | PointerEvent | WheelEvent) {
  const box = (event.currentTarget as HTMLImageElement).getBoundingClientRect();
  return { x: Math.max(0, Math.min(props.state.width - 1, (event.clientX - box.x) * props.state.width / box.width)),
    y: Math.max(0, Math.min(props.state.height - 1, (event.clientY - box.y) * props.state.height / box.height)) };
}
function context(event: MouseEvent) {
  if (props.state.kind !== "page") return;
  const { x, y } = coordinates(event);
  const target = props.state.targets?.find((item) => x >= item.x && y >= item.y && x < item.x + item.width && y < item.y + item.height);
  menu.value = { targetToken: target?.token, left: Math.min(event.clientX, window.innerWidth - 170), top: Math.min(event.clientY, window.innerHeight - 90), revision: props.state.revision };
}
function fill(type: "fill-username" | "fill-password") {
  const selected = menu.value;
  menu.value = null;
  if (!selected?.targetToken) { inputError.value = "请在可见的输入框上右键后填充"; return; }
  send({ type, targetToken: selected.targetToken }, selected.revision);
}
function wheel(event: WheelEvent) {
  if (props.state.kind === "page") send({ type: "scroll", ...coordinates(event), deltaY: Math.max(-1000, Math.min(1000, event.deltaY)) });
}
function send(input: Omit<ProtectedLoginInput, "revision">, revision?: string) {
  queue = queue.then(async () => {
    if (props.state.phase !== "interactive") return;
    try { await props.send({ ...input, revision: revision ?? props.state.revision }); inputError.value = ""; }
    catch { inputError.value = input.type.startsWith("fill-") ? "无法填充所选输入框：它可能已被替换、遮挡或设为只读。请在最新画面中重新选择。" : "未能完成验证操作，请重试；如持续失败，请重新后台登录"; }
  });
}
function pointer(event: PointerEvent, type: "mouseDown" | "mouseUp" | "mouseMove") {
  if (event.button !== 0 && type !== "mouseMove") return;
  const target = event.currentTarget as HTMLImageElement;
  const box = target.getBoundingClientRect();
  const x = Math.max(0, Math.min(props.state.width - 1, (event.clientX - box.x) * props.state.width / box.width));
  const y = Math.max(0, Math.min(props.state.height - 1, (event.clientY - box.y) * props.state.height / box.height));
  if (type === "mouseDown") {
    menu.value = null;
    dragging = true; moved = false; start = { x, y, revision: props.state.revision };
    target.setPointerCapture(event.pointerId); target.focus(); return;
  }
  if (!dragging || !start) {
    if (props.state.kind === "page" && type === "mouseMove" && Date.now() - lastMove >= 50) { lastMove = Date.now(); send({ type, x, y }); }
    return;
  }
  if (type === "mouseMove") {
    if (!moved && Math.hypot(x - start.x, y - start.y) < 3) return;
    if (Date.now() - lastMove < 50) return;
    lastMove = Date.now();
    if (!moved) { send({ type: "mouseDown", x: start.x, y: start.y }, start.revision); moved = true; }
    send({ type, x, y }, start.revision);
  } else {
    if (event.type === "pointercancel") { if (moved) send({ type: "mouseUp", x, y }, start.revision); }
    else send({ type: moved ? "mouseUp" : "click", x, y }, start.revision);
    dragging = false; start = null;
  }
}
function key(event: KeyboardEvent) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.key.length === 1) send({ type: "text", text: event.key });
  else if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) send({ type: "key", key: event.key.replace("Arrow", "") });
  else if (props.state.kind === "page" && ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown"].includes(event.key)) send({ type: "key", key: event.key.replace("Arrow", "") });
}
function paste(event: ClipboardEvent) {
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text && text.length <= 256) send({ type: "text", text });
}
watch(() => props.state.revision, () => { inputError.value = ""; menu.value = null; });
</script>

<template>
  <div class="protected-login" :class="{ 'is-assisted': state.kind === 'page' }" @pointerdown.stop @mousedown.stop>
    <ShieldCheck v-if="state.phase === 'failed' || state.phase === 'interactive'" :size="28" />
    <LoaderCircle v-else :size="28" class="is-spinning" />
    <strong>{{ state.phase === 'interactive' ? state.kind === 'page' ? '继续完成登录' : '完成登录验证' : state.phase === 'failed' ? '后台登录未完成' : state.pageLoading ? '正在加载网页' : '正在后台登录' }}</strong>
    <p>{{ state.message }}</p>
    <template v-if="state.phase === 'interactive' && state.image">
      <img class="protected-login__challenge" :src="state.image" :width="state.width" :height="state.height" alt="登录验证区域" tabindex="0" draggable="false"
        @pointerdown.prevent="pointer($event, 'mouseDown')" @pointerup.prevent="pointer($event, 'mouseUp')" @pointermove.prevent="pointer($event, 'mouseMove')"
        @pointercancel="pointer($event, 'mouseUp')" @keydown="key" @compositionend="send({ type: 'text', text: $event.data })" @paste="paste" @contextmenu.prevent="context" @wheel.prevent="wheel" />
      <small>{{ state.kind === "page" ? "托管密码已保护，浏览器插件保持禁用。完成站点登录后，点击下方按钮打开网页。" : state.kind === "agreement" ? "请在画面中阅读并选择协议选项，确认后系统会继续登录。" : "点击验证码输入框后输入，或操作滑块。完成后点击继续。" }}</small>
      <small v-if="inputError" class="protected-login__error">{{ inputError }}</small>
      <el-button v-if="state.kind !== 'agreement'" type="primary" @click="send({ type: 'continue' })">{{ state.kind === 'page' ? '登录完成，打开网页' : '继续登录' }}</el-button>
    </template>
    <el-button v-if="state.phase === 'failed'" type="primary" @click="$emit('retry')">重新后台登录</el-button>
    <el-button @click="$emit('browse')">打开网页</el-button>
    <small>停止本次自动登录，打开未填入托管密码的新网页。</small>
    <Teleport to="body">
      <div v-if="menu" class="protected-login__menu" :style="{ left: menu.left + 'px', top: menu.top + 'px' }" @pointerdown.stop @mousedown.stop @contextmenu.prevent>
        <button type="button" @click="fill('fill-username')">填充用户名</button>
        <button type="button" @click="fill('fill-password')">填充密码</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.protected-login { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 14px; padding: 24px; overflow: auto; background: var(--surface, #fff); color: var(--teal-600); }
.protected-login strong { color: var(--ink-800); font-size: 16px; }
.protected-login p, .protected-login small { margin: 0; max-width: 520px; text-align: center; color: var(--ink-500); line-height: 1.65; }
.protected-login__challenge { max-width: 100%; height: auto; flex: none; border: 1px solid var(--ink-100); border-radius: 8px; touch-action: none; }
.protected-login__challenge:focus { outline: 2px solid var(--teal-500); outline-offset: 3px; }
.protected-login .protected-login__error { color: var(--el-color-danger); }
.protected-login.is-assisted { gap: 8px; padding: 12px; }
.protected-login.is-assisted .protected-login__challenge { max-height: calc(100% - 180px); width: auto; height: auto; }
.protected-login__menu { position: fixed; z-index: 4000; width: 160px; padding: 4px; background: var(--surface, #fff); border: 1px solid var(--ink-100); border-radius: 6px; box-shadow: 0 4px 16px #0002; }
.protected-login__menu button { display: block; width: 100%; padding: 8px 12px; border: 0; border-radius: 3px; background: transparent; color: var(--ink-800); text-align: left; cursor: pointer; }
.protected-login__menu button:hover { background: var(--ink-50); }
</style>
