<script setup lang="ts">
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { consoleUsesLightPalette, theme } from "../theme";

const props = defineProps<{
  modelValue: string;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  save: [];
  imageFiles: [files: File[]];
}>();

const element = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeObserver: ResizeObserver | null = null;

const monacoGlobal = self as typeof self & {
  MonacoEnvironment?: { getWorker(_moduleId: string, _label: string): Worker };
};
monacoGlobal.MonacoEnvironment = { getWorker: () => new EditorWorker() };

function editorTheme(): "vs" | "vs-dark" {
  return consoleUsesLightPalette() ? "vs" : "vs-dark";
}

function imageFiles(files: FileList | null): File[] {
  return [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
}

function handlePaste(event: ClipboardEvent) {
  const files = imageFiles(event.clipboardData?.files ?? null);
  if (!files.length) return;
  event.preventDefault();
  emit("imageFiles", files);
}

function handleDrop(event: DragEvent) {
  const files = imageFiles(event.dataTransfer?.files ?? null);
  if (!files.length) return;
  event.preventDefault();
  emit("imageFiles", files);
}

function insertText(value: string) {
  if (!editor) return;
  const selection = editor.getSelection();
  const range = selection ?? new monaco.Range(1, 1, 1, 1);
  editor.executeEdits("knowledge-image", [{ range, text: value, forceMoveMarkers: true }]);
  editor.focus();
}

function focus() {
  editor?.focus();
}

defineExpose({ insertText, focus });

onMounted(() => {
  editor = monaco.editor.create(element.value!, {
    value: props.modelValue,
    language: "markdown",
    theme: editorTheme(),
    readOnly: props.readonly,
    automaticLayout: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    lineHeight: 23,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    roundedSelection: false,
    editContext: false,
    padding: { top: 18, bottom: 22 },
    wordWrap: "on",
    wrappingIndent: "indent",
    lineNumbersMinChars: 3,
    bracketPairColorization: { enabled: true },
  });
  editor.onDidChangeModelContent(() => emit("update:modelValue", editor?.getValue() ?? ""));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit("save"));
  element.value!.addEventListener("paste", handlePaste, true);
  element.value!.addEventListener("drop", handleDrop, true);
  resizeObserver = new ResizeObserver(() => editor?.layout());
  resizeObserver.observe(element.value!);
});

watch(() => props.modelValue, (value) => {
  if (editor && value !== editor.getValue()) editor.setValue(value);
});

watch(() => props.readonly, (readonly) => editor?.updateOptions({ readOnly: readonly }));
watch(theme, () => monaco.editor.setTheme(editorTheme()));
onActivated(() => nextTick(() => editor?.layout()));

onBeforeUnmount(() => {
  if (element.value) {
    element.value.removeEventListener("paste", handlePaste, true);
    element.value.removeEventListener("drop", handleDrop, true);
  }
  resizeObserver?.disconnect();
  editor?.dispose();
});
</script>

<template>
  <div ref="element" class="markdown-editor"></div>
</template>

<style scoped>
.markdown-editor { width: 100%; height: 100%; min-height: 0; }
</style>
