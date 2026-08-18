<script setup lang="ts">import { translate as tr } from "../i18n";

import { TabulatorFull as Tabulator, type ColumnDefinition } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  columns: Array<{ name: string; table?: string; type?: number }>;
  rows: Array<Record<string, unknown>>;
}>();

const element = ref<HTMLElement | null>(null);
let table: Tabulator | null = null;

function definitions(): ColumnDefinition[] {
  return props.columns.map((column) => ({
    title: column.name,
    field: column.name,
    minWidth: 120,
    headerSort: true,
    tooltip: true,
    formatter: (cell) => {
      const value = cell.getValue();
      if (value === null) return "<span class='db-null'>NULL</span>";
      if (value === undefined) return "";
      const text = typeof value === "object" ? JSON.stringify(value) : String(value);
      const node = document.createElement("span");
      node.textContent = text;
      return node;
    },
  }));
}

async function render() {
  await nextTick();
  if (!element.value) return;
  if (!table) {
    table = new Tabulator(element.value, {
      data: props.rows,
      columns: definitions(),
      height: "100%",
      layout: "fitDataFill",
      movableColumns: true,
      resizableColumnFit: false,
      clipboard: true,
      selectableRows: true,
      placeholder: tr("查询没有返回数据行"),
    });
  } else {
    table.setColumns(definitions());
    await table.setData(props.rows);
  }
}

onMounted(render);
onActivated(() => nextTick(() => table?.redraw(true)));
watch(() => [props.columns, props.rows], render, { deep: true });
onBeforeUnmount(() => table?.destroy());
</script>

<template>
  <div ref="element" class="query-result-grid"></div>
</template>
