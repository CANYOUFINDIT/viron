<script setup lang="ts">
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { consoleUsesLightPalette, theme } from "../theme";
import { onAppShortcut } from "../keyboard-shortcuts";

const props = defineProps<{ modelValue: string; commands?: string[] }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; execute: [text: string] }>();
const element = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let completionProvider: monaco.IDisposable | null = null;
let resizeObserver: ResizeObserver | null = null;
let removeShortcutListener: (() => void) | undefined;

function editorTheme(): "vs" | "vs-dark" {
  return consoleUsesLightPalette() ? "vs" : "vs-dark";
}

const monacoGlobal = self as typeof self & { MonacoEnvironment?: { getWorker(_moduleId: string, _label: string): Worker } };
monacoGlobal.MonacoEnvironment = { getWorker: () => new EditorWorker() };

if (!monaco.languages.getLanguages().some((language) => language.id === "viron-redis")) {
  monaco.languages.register({ id: "viron-redis" });
  monaco.languages.setMonarchTokensProvider("viron-redis", {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*(GET|SET|DEL|UNLINK|EXISTS|TYPE|TTL|PTTL|EXPIRE|PEXPIRE|PERSIST|RENAME|RENAMENX|COPY|SCAN|HGET|HMGET|HSET|HDEL|HSCAN|HLEN|LRANGE|LPUSH|RPUSH|LPOP|RPOP|LSET|LREM|LLEN|SADD|SREM|SSCAN|SCARD|ZADD|ZREM|ZSCAN|ZRANGE|ZREVRANGE|ZCARD|ZSCORE|XADD|XDEL|XRANGE|XREVRANGE|XLEN|INFO|SLOWLOG|MEMORY|OBJECT|PING|DBSIZE|STRLEN|MGET|MSET)\b/, "keyword"],
        [/#.*$/, "comment"],
        [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, "string"],
        [/-?\d+(?:\.\d+)?\b/, "number"],
      ],
    },
  });
}

function selectedText(): string {
  if (!editor) return props.modelValue;
  const selection = editor.getSelection();
  const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) : "";
  return selected?.trim() || editor.getValue();
}

onMounted(() => {
  editor = monaco.editor.create(element.value!, {
    value: props.modelValue,
    language: "viron-redis",
    theme: editorTheme(),
    automaticLayout: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    lineHeight: 23,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "gutter",
    padding: { top: 12, bottom: 12 },
    wordWrap: "on",
    suggest: { showKeywords: true, preview: true },
  });
  editor.onDidChangeModelContent(() => emit("update:modelValue", editor?.getValue() ?? ""));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit("execute", selectedText()));
  editor.addCommand(monaco.KeyCode.F5, () => emit("execute", selectedText()));
  removeShortcutListener = onAppShortcut((action) => {
    if (action === "workspace.execute" && element.value?.getClientRects().length) emit("execute", selectedText());
  });
  completionProvider = monaco.languages.registerCompletionItemProvider("viron-redis", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: (props.commands ?? []).map((label) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: label,
          range,
        })),
      };
    },
  });
  resizeObserver = new ResizeObserver(() => editor?.layout());
  resizeObserver.observe(element.value!);
});

watch(() => props.modelValue, (value) => {
  if (editor && value !== editor.getValue()) editor.setValue(value);
});

watch(theme, () => monaco.editor.setTheme(editorTheme()));

onActivated(() => nextTick(() => editor?.layout()));
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  removeShortcutListener?.();
  completionProvider?.dispose();
  editor?.dispose();
});
</script>

<template><div ref="element" class="redis-command-editor"></div></template>
