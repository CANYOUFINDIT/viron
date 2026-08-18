import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("connection pool table layout", () => {
  const view = source("src/client/views/ConnectionPoolView.vue");
  const styles = source("src/client/styles/base.css");

  it("keeps connection names truncated with their full value available on hover", () => {
    const immediateTooltips = view.match(/<el-tooltip :content="row\.name" placement="bottom-start" :show-after="0" :hide-after="0" :enterable="false" transition="none">/g) ?? [];

    expect(immediateTooltips).toHaveLength(2);
    expect(view).not.toContain(':title="row.name"');
    expect(styles).toContain(".connection-identity-copy { flex: 1 1 auto; min-width: 0; }");
    expect(styles).toContain(".connection-identity strong, .connection-identity small { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
  });

  it("renders connection type in its own desktop column and mobile metadata", () => {
    const nameColumn = view.indexOf('<el-table-column :label="$t(\'连接名称\')"');
    const typeColumn = view.indexOf('<el-table-column :label="$t(\'连接类型\')" width="120">');
    const targetColumn = view.indexOf('<el-table-column :label="$t(\'目标地址\')"');

    expect(nameColumn).toBeGreaterThan(-1);
    expect(typeColumn).toBeGreaterThan(nameColumn);
    expect(targetColumn).toBeGreaterThan(typeColumn);
    expect(view).toContain("{{ connectionTypeLabel(row) }}");
    expect(view).toContain("const CONNECTION_GROUP_COLUMN_SPAN = 10;");
  });
});
