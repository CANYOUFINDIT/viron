import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const designer = readFileSync(new URL("../src/client/components/TableDesigner.vue", import.meta.url), "utf8");

describe("database table designer loading", () => {
  it("bounds slow structure reads and exposes a retryable error state", () => {
    expect(designer).toContain("const TABLE_DESIGN_LOAD_TIMEOUT_MS = 45_000;");
    expect(designer).toContain("const controller = new AbortController();");
    expect(designer).toContain("{ signal: controller.signal }");
    expect(designer).toContain(':element-loading-text="loadingMessage"');
    expect(designer).toContain('v-if="loadError" class="table-designer-load-error"');
    expect(designer).toContain('@click="loadExistingTable"');
    expect(designer).toContain(':disabled="saving || loading || Boolean(loadError)"');
    expect(designer).toContain('if (loading.value) return ElMessage.info(tr("数据表结构仍在读取，请稍候"));');
    expect(designer).toContain('if (loadError.value) return ElMessage.warning(tr("数据表结构尚未完整加载，请重试后再保存"));');
  });
});
