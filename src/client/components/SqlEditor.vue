<script setup lang="ts">
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { sqlStatementAtOffset } from "../../shared/sql-statements";
import { sqlCompletionSuggestions, type SqlCompletionContext, type SqlCompletionKind } from "../sql-completion";
import { consoleUsesLightPalette, theme } from "../theme";

const props = defineProps<{
  modelValue: string;
  completion?: SqlCompletionContext;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  execute: [sql: string];
}>();

const element = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let completionProvider: monaco.IDisposable | null = null;
let resizeObserver: ResizeObserver | null = null;

function editorTheme(): "vs" | "vs-dark" {
  return consoleUsesLightPalette() ? "vs" : "vs-dark";
}

const monacoGlobal = self as typeof self & {
  MonacoEnvironment?: { getWorker(_moduleId: string, _label: string): Worker };
};
monacoGlobal.MonacoEnvironment = { getWorker: () => new EditorWorker() };

function selectedSql(): string {
  if (!editor) return props.modelValue;
  const selection = editor.getSelection();
  const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) : "";
  return selected?.trim() || "";
}

function executableSql(): string {
  return selectedSql() || editor?.getValue() || props.modelValue;
}

function currentStatementSql(): string {
  if (!editor) return props.modelValue.trim();
  const selection = editor.getSelection();
  const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) : "";
  if (selected?.trim()) return selected.trim();
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return editor.getValue().trim();
  return sqlStatementAtOffset(editor.getValue(), model.getOffsetAt(position));
}

function openFind(): void {
  editor?.trigger("viron", "actions.find", null);
}

function completionKind(kind: SqlCompletionKind): monaco.languages.CompletionItemKind {
  const kinds: Record<SqlCompletionKind, monaco.languages.CompletionItemKind> = {
    keyword: monaco.languages.CompletionItemKind.Keyword,
    schema: monaco.languages.CompletionItemKind.Module,
    table: monaco.languages.CompletionItemKind.Struct,
    view: monaco.languages.CompletionItemKind.Interface,
    column: monaco.languages.CompletionItemKind.Field,
    function: monaco.languages.CompletionItemKind.Function,
    procedure: monaco.languages.CompletionItemKind.Method,
    parameter: monaco.languages.CompletionItemKind.Variable,
  };
  return kinds[kind];
}

defineExpose({ currentStatementSql, selectedSql, openFind });

onMounted(() => {
  editor = monaco.editor.create(element.value!, {
    value: props.modelValue,
    language: "sql",
    theme: editorTheme(),
    automaticLayout: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    lineHeight: 23,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "gutter",
    roundedSelection: false,
    editContext: false,
    padding: { top: 12, bottom: 12 },
    wordWrap: "off",
    quickSuggestions: { other: true, comments: false, strings: false },
    quickSuggestionsDelay: 50,
    suggestOnTriggerCharacters: true,
    suggest: { showKeywords: true, preview: true },
    bracketPairColorization: { enabled: true },
  });
  editor.onDidChangeModelContent((event) => {
    emit("update:modelValue", editor?.getValue() ?? "");
    if (editor?.hasTextFocus() && event.changes.some((change) => change.text.endsWith("."))) {
      queueMicrotask(() => editor?.trigger("keyboard", "editor.action.triggerSuggest", {}));
    }
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit("execute", executableSql()));
  editor.addCommand(monaco.KeyCode.F5, () => emit("execute", executableSql()));
  completionProvider = monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", "`", "[", "$"],
    provideCompletionItems(model, position) {
      const offset = model.getOffsetAt(position);
      const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const partial = lineBefore.match(/(?:`[^`]*|[A-Za-z0-9_$]*)$/)?.[0] ?? "";
      const range = new monaco.Range(position.lineNumber, position.column - partial.length, position.lineNumber, position.column);
      const qualifier = lineBefore.match(/(?:`(?:``|[^`])+`|[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(?:`[^`]*|[A-Za-z0-9_$]*)$/)?.[0] ?? "";
      const qualifierRange = new monaco.Range(position.lineNumber, position.column - qualifier.length, position.lineNumber, position.column);
      const suggestions = sqlCompletionSuggestions(model.getValue(), offset, props.completion ?? { schemas: [] });
      return {
        suggestions: suggestions.map((suggestion) => ({
          label: suggestion.label,
          kind: completionKind(suggestion.kind),
          insertText: suggestion.insertText,
          insertTextRules: suggestion.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          detail: suggestion.detail,
          sortText: suggestion.sortText,
          filterText: suggestion.filterText ?? suggestion.label,
          range: suggestion.replaceQualifier && qualifier ? qualifierRange : range,
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

watch(() => props.completion?.catalog, (catalog) => {
  if (!catalog || !editor?.hasTextFocus() || !editor.getValue().trim()) return;
  queueMicrotask(() => editor?.trigger("completion", "editor.action.triggerSuggest", {}));
});

watch(theme, () => monaco.editor.setTheme(editorTheme()));

onActivated(() => nextTick(() => editor?.layout()));

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  completionProvider?.dispose();
  editor?.dispose();
});
</script>

<template>
  <div ref="element" class="sql-editor"></div>
</template>
