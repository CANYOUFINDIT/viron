<script setup lang="ts">
import { TerminalSquare } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { editLoginScriptIndent } from "../ssh-login-script";
import TipIcon from "./TipIcon.vue";

const props = withDefaults(defineProps<{
  modelValue: string;
  enabled: boolean;
  maxLength?: number;
}>(), {
  maxLength: 65536,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:enabled": [value: boolean];
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const lineNumberGutter = ref<HTMLElement | null>(null);
const lineCount = computed(() => Math.max(1, props.modelValue.split("\n").length));
const lineNumbers = computed(() => Array.from({ length: lineCount.value }, (_, index) => index + 1).join("\n"));

function updateValue(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}

function updateEnabled(value: string | number | boolean) {
  emit("update:enabled", Boolean(value));
}

function syncScroll(event: Event) {
  if (lineNumberGutter.value) lineNumberGutter.value.scrollTop = (event.target as HTMLTextAreaElement).scrollTop;
}

async function handleTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || !props.enabled || !textarea.value) return;
  event.preventDefault();
  const result = editLoginScriptIndent(
    props.modelValue,
    textarea.value.selectionStart,
    textarea.value.selectionEnd,
    event.shiftKey,
  );
  emit("update:modelValue", result.value);
  await nextTick();
  textarea.value?.setSelectionRange(result.selectionStart, result.selectionEnd);
}
</script>

<template>
  <div class="login-script-editor">
    <section class="login-script-editor__terminal" :class="{ 'is-readonly': !enabled }">
      <header class="login-script-editor__toolbar">
        <div class="login-script-editor__title">
          <TerminalSquare :size="15" aria-hidden="true" />
          <strong>{{ $t('Shell 命令') }}</strong>
          <TipIcon :content="$t('命令在交互式 Shell 建立后按原顺序写入一次，输出会显示在终端并进入录像。')" placement="right" />
          <span><i />{{ enabled ? $t('登录后执行 1 次') : $t('已停用，内容会保留') }}</span>
        </div>
        <el-switch
          :model-value="enabled"
          :aria-label="$t('SSH 登录后自动执行')"
          @update:model-value="updateEnabled"
        />
      </header>

      <div class="login-script-editor__body">
        <div ref="lineNumberGutter" class="login-script-editor__gutter" aria-hidden="true">
          <pre>{{ lineNumbers }}</pre>
        </div>
        <textarea
          ref="textarea"
          :value="modelValue"
          :maxlength="maxLength"
          :readonly="!enabled"
          :aria-readonly="!enabled"
          :aria-label="$t('SSH 登录脚本命令')"
          rows="7"
          wrap="off"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          :placeholder="$t('# 登录后执行一次，支持多行 Shell 命令\ncd /opt/app\nexport APP_ENV=production\ngit status')"
          @input="updateValue"
          @scroll="syncScroll"
          @keydown="handleTab"
        />
      </div>

      <footer class="login-script-editor__statusbar">
        <span><kbd>Enter</kbd> {{ $t('换行 ·') }} <kbd>Tab</kbd> {{ $t('缩进') }}</span>
        <span>{{ lineCount }} {{ $t('行 ·') }} {{ modelValue.length.toLocaleString() }} / {{ maxLength.toLocaleString() }} {{ $t('字符') }}</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.login-script-editor {
  width: 100%;
  min-width: 0;
}

.login-script-editor__terminal {
  overflow: hidden;
  border: 1px solid #294044;
  border-radius: 9px;
  background: #091416;
  color: #cfddda;
  box-shadow: 0 0 0 1px rgba(8, 22, 25, .08);
  transition: border-color .16s ease, box-shadow .16s ease;
}

.login-script-editor__terminal:focus-within {
  border-color: #2baa91;
  box-shadow: 0 0 0 3px rgba(33, 151, 128, .14);
}

.login-script-editor__toolbar,
.login-script-editor__statusbar {
  min-height: 38px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #102023;
}

.login-script-editor__toolbar {
  border-bottom: 1px solid #25393d;
}

.login-script-editor__title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.login-script-editor__title > svg {
  flex: 0 0 auto;
  color: #62d6ba;
}

.login-script-editor__title strong {
  color: #e6efed;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: .02em;
}

.login-script-editor__title span {
  overflow: hidden;
  color: #8da39f;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.login-script-editor__title i {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #40c8a6;
  box-shadow: 0 0 0 3px rgba(64, 200, 166, .1);
}

.login-script-editor__body {
  min-height: 176px;
  display: grid;
  grid-template-columns: 45px minmax(0, 1fr);
  background: #091416;
}

.login-script-editor__gutter {
  height: 100%;
  overflow: hidden;
  border-right: 1px solid #1d3033;
  background: #0d191b;
  color: #526c6c;
  user-select: none;
}

.login-script-editor__gutter pre {
  margin: 0;
  padding: 13px 10px 16px 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 22px;
  text-align: right;
}

.login-script-editor textarea {
  width: 100%;
  min-width: 0;
  min-height: 176px;
  margin: 0;
  padding: 13px 15px 16px;
  resize: vertical;
  border: 0;
  outline: 0;
  background: transparent;
  color: #dce8e5;
  caret-color: #62d6ba;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 22px;
  tab-size: 2;
  white-space: pre;
}

.login-script-editor textarea::placeholder {
  color: #59706f;
  opacity: 1;
}

.login-script-editor__statusbar {
  min-height: 31px;
  border-top: 1px solid #1d3033;
  color: #718985;
  font-family: var(--font-mono);
  font-size: 10px;
}

.login-script-editor__statusbar kbd {
  padding: 1px 4px;
  border: 1px solid #3a5152;
  border-radius: 3px;
  background: #17282a;
  color: #9bb0ac;
  font-family: inherit;
  font-size: 9px;
}

.login-script-editor__terminal.is-readonly {
  border-color: #314044;
}

.is-readonly .login-script-editor__title i {
  background: #667a79;
  box-shadow: none;
}

.is-readonly textarea {
  color: #738987;
  cursor: default;
}

.login-script-editor > p {
  margin: 8px 1px 0;
  color: var(--ink-500);
  font-size: 12px;
  line-height: 1.55;
}

:deep(.el-switch) {
  flex: 0 0 auto;
}

@media (max-width: 640px) {
  .login-script-editor__title span,
  .login-script-editor__statusbar span:first-child {
    display: none;
  }
}
</style>
