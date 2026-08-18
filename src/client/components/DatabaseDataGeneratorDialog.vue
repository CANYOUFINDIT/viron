<script setup lang="ts">import { translate as tr } from "../i18n";

import { Dice5, RefreshCw } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { api } from "../api";

interface FieldDesign { name: string; type: string; notNull: boolean; autoIncrement: boolean; defaultKind: string }
interface FieldGenerator { name: string; type: string; generator: string; fixedValue: string; nullRate: number; enabled: boolean }

const props = defineProps<{ visible: boolean; connectionId: string; database: string; table: string }>();
const emit = defineEmits<{ close: []; generate: [sql: string, run: boolean] }>();

const loading = ref(false);
const rowCount = ref(100);
const seed = ref(1);
const fields = ref<FieldGenerator[]>([]);

const previewRows = computed(() => Array.from({ length: Math.min(5, rowCount.value) }, (_, index) => Object.fromEntries(fields.value.filter((field) => field.enabled).map((field) => [field.name, generatedValue(field, index)]))));

function generatorFor(field: FieldDesign): string {
  const type = field.type.toUpperCase();
  if (field.autoIncrement) return "increment";
  if (/INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL/.test(type)) return "random-number";
  if (/DATE|TIME|YEAR/.test(type)) return "date";
  if (/BOOL|BIT|TINYINT/.test(type)) return "boolean";
  if (/CHAR|TEXT|ENUM|SET|JSON/.test(type)) return /email/i.test(field.name) ? "email" : /name/i.test(field.name) ? "name" : "uuid";
  return "fixed";
}

function random(index: number, salt: number): number {
  const value = Math.sin((seed.value + 1) * 12_989.7 + index * 78_233 + salt * 37.7) * 43_758.5453;
  return value - Math.floor(value);
}

function generatedValue(field: FieldGenerator, index: number): unknown {
  if (!field.enabled) return undefined;
  if (field.nullRate > 0 && random(index, field.name.length) * 100 < field.nullRate) return null;
  if (field.generator === "increment") return index + 1;
  if (field.generator === "random-number") return Math.floor(random(index, field.name.length + 2) * 100_000);
  if (field.generator === "boolean") return random(index, field.name.length + 3) > 0.5 ? 1 : 0;
  if (field.generator === "date") return new Date(Date.UTC(2020 + Math.floor(random(index, 2) * 7), Math.floor(random(index, 3) * 12), 1 + Math.floor(random(index, 4) * 27))).toISOString().slice(0, 19).replace("T", " ");
  if (field.generator === "email") return `user${index + 1}@example.test`;
  if (field.generator === "name") return `name_${String(index + 1).padStart(4, "0")}`;
  if (field.generator === "uuid") return `${(seed.value + index).toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
  if (field.generator === "null") return null;
  return field.fixedValue;
}

function escapeValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function buildSql(): string {
  const selected = fields.value.filter((field) => field.enabled);
  if (!selected.length) return "";
  const statements: string[] = [];
  for (let offset = 0; offset < rowCount.value; offset += 200) {
    const count = Math.min(200, rowCount.value - offset);
    const values = Array.from({ length: count }, (_, index) => `(${selected.map((field) => escapeValue(generatedValue(field, offset + index))).join(", ")})`).join(",\n");
    statements.push(`INSERT INTO ${identifier(props.database)}.${identifier(props.table)} (${selected.map((field) => identifier(field.name)).join(", ")}) VALUES\n${values};`);
  }
  return statements.join("\n\n");
}

async function load() {
  if (!props.connectionId || !props.database || !props.table) return;
  loading.value = true;
  try {
    const response = await api<{ design: { fields: FieldDesign[] } }>(`/api/v1/database-connections/${props.connectionId}/table-design?database=${encodeURIComponent(props.database)}&table=${encodeURIComponent(props.table)}`);
    fields.value = response.design.fields.map((field) => ({ name: field.name, type: field.type, generator: generatorFor(field), fixedValue: "", nullRate: field.notNull ? 0 : 5, enabled: !field.autoIncrement }));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取数据表字段失败"));
  } finally {
    loading.value = false;
  }
}

function finish(run: boolean) {
  const sql = buildSql();
  if (!sql) return ElMessage.warning(tr("请至少选择一个生成字段"));
  emit("generate", sql, run);
  emit("close");
}

watch(() => props.visible, (visible) => { if (visible) void load(); });
</script>

<template>
  <el-dialog :model-value="visible" class="database-data-generator-dialog" :title="$t('数据生成 · {0}.{1}', [database, table])" width="min(980px, 94vw)" append-to-body destroy-on-close :close-on-click-modal="false" @close="emit('close')">
    <div class="database-data-generator" v-loading="loading">
      <header><label><span>{{ $t('生成行数') }}</span><el-input-number v-model="rowCount" :min="1" :max="1000" /></label><label><span>{{ $t('随机种子') }}</span><el-input-number v-model="seed" :min="0" :max="999999" /></label><button @click="seed += 1"><RefreshCw :size="14" />{{ $t('重新生成预览') }}</button></header>
      <table class="database-data-generator-fields"><thead><tr><th>{{ $t('生成') }}</th><th>{{ $t('字段') }}</th><th>{{ $t('类型') }}</th><th>{{ $t('生成器') }}</th><th>{{ $t('固定值') }}</th><th>Null %</th></tr></thead><tbody><tr v-for="field in fields" :key="field.name"><td><el-checkbox v-model="field.enabled" /></td><td>{{ field.name }}</td><td>{{ field.type }}</td><td><el-select v-model="field.generator"><el-option :label="$t('递增序列')" value="increment" /><el-option :label="$t('随机数字')" value="random-number" /><el-option label="UUID" value="uuid" /><el-option :label="$t('名称')" value="name" /><el-option :label="$t('电子邮件')" value="email" /><el-option :label="$t('日期时间')" value="date" /><el-option :label="$t('布尔值')" value="boolean" /><el-option :label="$t('固定值')" value="fixed" /><el-option label="NULL" value="null" /></el-select></td><td><el-input v-model="field.fixedValue" :disabled="field.generator !== 'fixed'" /></td><td><el-input-number v-model="field.nullRate" :min="0" :max="100" :disabled="field.generator === 'null'" /></td></tr></tbody></table>
      <section class="database-data-generator-preview"><header><Dice5 :size="16" /><strong>{{ $t('数据预览') }}</strong></header><div><table><thead><tr><th v-for="field in fields.filter((item) => item.enabled)" :key="field.name">{{ field.name }}</th></tr></thead><tbody><tr v-for="(row, index) in previewRows" :key="index"><td v-for="field in fields.filter((item) => item.enabled)" :key="field.name">{{ row[field.name] === null ? 'NULL' : row[field.name] }}</td></tr></tbody></table></div></section>
    </div>
    <template #footer><el-button @click="emit('close')">{{ $t('取消') }}</el-button><el-button @click="finish(false)">{{ $t('生成到 SQL') }}</el-button><el-button type="primary" @click="finish(true)">{{ $t('生成数据') }}</el-button></template>
  </el-dialog>
</template>
