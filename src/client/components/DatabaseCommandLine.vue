<script setup lang="ts">import { translate as tr } from "../i18n";

import { ChevronRight, CircleStop, Trash2 } from "@lucide/vue";
import { nextTick, onMounted, ref, watch } from "vue";
import { api } from "../api";

interface QueryResultSet {
  columns: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  affectedRows: number;
  info: string;
  truncated: boolean;
}
interface QueryJob {
  id: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  resultSets: QueryResultSet[];
}

const props = defineProps<{ connectionId: string; connectionName: string; database: string }>();
const emit = defineEmits<{ close: []; databaseChange: [database: string] }>();

const command = ref("");
const currentDatabase = ref(props.database);
const running = ref(false);
const activeJobId = ref("");
const output = ref<Array<{ id: number; kind: "command" | "result" | "error" | "notice"; text: string }>>([
  { id: 1, kind: "notice", text: "Viron database command line. SQL executes through the current audited database connection." },
]);
const history = ref<string[]>([]);
const historyIndex = ref(0);
const input = ref<HTMLInputElement | null>(null);
const scroll = ref<HTMLElement | null>(null);
let outputId = 1;

watch(() => props.database, (database) => {
  if (database) currentDatabase.value = database;
});

function append(kind: "command" | "result" | "error" | "notice", text: string) {
  output.value.push({ id: ++outputId, kind, text });
  void nextTick(() => { if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight; });
}

function display(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function resultText(result: QueryResultSet): string {
  if (!result.rows.length) return result.info || `Query OK, ${result.affectedRows} row(s) affected`;
  const columns = result.columns.map((item) => item.name);
  const widths = columns.map((column) => Math.min(48, Math.max(column.length, ...result.rows.slice(0, 200).map((row) => display(row[column]).length))));
  const line = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const row = (values: string[]) => `| ${values.map((value, index) => value.slice(0, widths[index]).padEnd(widths[index])).join(" | ")} |`;
  return [line, row(columns), line, ...result.rows.slice(0, 200).map((item) => row(columns.map((column) => display(item[column])))), line, `${result.rows.length}${result.truncated ? "+" : ""} row(s)`].join("\n");
}

async function waitForJob(id: string): Promise<QueryJob> {
  for (let attempt = 0; attempt < 7_200; attempt += 1) {
    const response = await api<{ job: QueryJob }>(`/api/v1/database-queries/${id}`);
    if (!["pending", "running"].includes(response.job.status)) return response.job;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Query timed out");
}

async function execute() {
  const statement = command.value.trim();
  if (!statement || running.value) return;
  history.value.push(statement);
  historyIndex.value = history.value.length;
  command.value = "";
  append("command", `${currentDatabase.value || "(none)"}> ${statement}`);
  if (/^(?:\\q|quit|exit);?$/i.test(statement)) {
    emit("close");
    return;
  }
  if (/^(?:\\c|clear);?$/i.test(statement)) {
    output.value = [];
    return;
  }
  const use = statement.match(/^(?:USE\s+|\\u\s+)(?:`((?:``|[^`])+)`|([^;\s]+))\s*;?$/i);
  if (use) {
    currentDatabase.value = (use[1] ?? use[2]).replaceAll("``", "`");
    emit("databaseChange", currentDatabase.value);
    append("notice", `Database changed to ${currentDatabase.value}`);
    return;
  }
  if (/^(?:source|\\\.)\s+/i.test(statement)) {
    append("error", tr("Use “运行 SQL 文件…” from the Navicat connection menu to execute a local SQL file."));
    return;
  }
  running.value = true;
  try {
    const created = await api<{ job: QueryJob }>(`/api/v1/database-connections/${props.connectionId}/queries`, { method: "POST", body: JSON.stringify({ sql: statement, database: currentDatabase.value }) });
    activeJobId.value = created.job.id;
    const job = await waitForJob(created.job.id);
    if (job.status !== "success") throw new Error(job.error || (job.status === "cancelled" ? "Query cancelled" : "Query failed"));
    for (const result of job.resultSets) append("result", resultText(result));
    append("notice", `${job.durationMs ?? 0} ms`);
  } catch (error) {
    append("error", error instanceof Error ? error.message : String(error));
  } finally {
    running.value = false;
    activeJobId.value = "";
    await nextTick();
    input.value?.focus();
  }
}

async function cancel() {
  if (!activeJobId.value) return;
  await api(`/api/v1/database-queries/${activeJobId.value}`, { method: "DELETE" }).catch(() => undefined);
}

function navigateHistory(direction: number) {
  if (!history.value.length) return;
  historyIndex.value = Math.max(0, Math.min(history.value.length, historyIndex.value + direction));
  command.value = historyIndex.value === history.value.length ? "" : history.value[historyIndex.value];
  void nextTick(() => input.value?.setSelectionRange(command.value.length, command.value.length));
}

onMounted(() => input.value?.focus());
</script>

<template>
  <section class="database-command-line">
    <header><strong>{{ connectionName }}</strong><span>{{ currentDatabase || "No database selected" }}</span><button :title="$t('清空')" @click="output = []"><Trash2 :size="14" /></button><button :title="$t('停止')" :disabled="!running" @click="cancel"><CircleStop :size="14" /></button></header>
    <main ref="scroll"><pre v-for="item in output" :key="item.id" :class="`is-${item.kind}`">{{ item.text }}</pre><span v-if="running" class="database-command-line__running">Executing…</span></main>
    <footer><ChevronRight :size="15" /><span>{{ currentDatabase || "mysql" }}&gt;</span><input ref="input" v-model="command" :disabled="running" autocomplete="off" spellcheck="false" @keydown.enter.prevent="execute" @keydown.up.prevent="navigateHistory(-1)" @keydown.down.prevent="navigateHistory(1)" /></footer>
  </section>
</template>
