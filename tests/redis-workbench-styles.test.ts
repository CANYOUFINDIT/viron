import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pane = readFileSync(new URL("../src/client/components/RedisWorkbench.vue", import.meta.url), "utf8");

describe("Redis test connection control", () => {
  it("matches the database select height and uses a connection probe icon", () => {
    expect(pane).toContain('<el-button class="redis-test-connection" size="small" :loading="busy" @click="testConnection"><PlugZap :size="14" />{{ $t(\'测试连接\') }}</el-button>');
    expect(pane).toContain(".redis-database-select :deep(.el-select__wrapper) { height: 31px; min-height: 31px; font-family: var(--font-mono); }");
    expect(pane).toContain(".redis-test-connection { --el-button-size: 31px; height: 31px; min-height: 31px; padding: 0 12px; border-radius: var(--el-border-radius-base); }");
    expect(pane).not.toContain("<CircleCheck :size=\"14\" />{{ $t('测试连接') }}");
  });
});

describe("Redis workbench selected rows", () => {
  it("marks the selected connection with a fill instead of a framed card or left rail", () => {
    expect(pane).toContain(".redis-connection-list section > button.is-active { background: var(--teal-50); color: var(--teal-700); }");
    expect(pane).toContain(".redis-connection-list section > button.is-active .redis-connection-icon { border-color: color-mix(in srgb, var(--teal-500) 32%, var(--ink-200)); color: var(--teal-700); }");
    expect(pane).toContain(".redis-connection-list section > button:focus-visible { outline: 2px solid var(--teal-500); outline-offset: -2px; }");
    expect(pane).not.toContain("box-shadow: inset 2px 0 var(--teal-500)");
    expect(pane).not.toContain("box-shadow: inset 3px 0 var(--teal-500)");
  });
});
