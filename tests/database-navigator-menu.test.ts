import { describe, expect, it } from "vitest";
import {
  buildConnectionNavigatorMenu,
  buildDatabaseNavigatorMenu,
  type DatabaseNavigatorMenuItem,
} from "../src/client/database-navigator-menu.js";

function item(items: DatabaseNavigatorMenuItem[], key: string): DatabaseNavigatorMenuItem {
  const pending = [...items];
  let found: DatabaseNavigatorMenuItem | undefined;
  while (pending.length && !found) {
    const candidate = pending.shift()!;
    if (candidate.key === key) found = candidate;
    else pending.push(...(candidate.children ?? []));
  }
  if (!found) throw new Error(`Missing menu item ${key}`);
  return found;
}

describe("database navigator menu", () => {
  it("keeps the Navicat database action order while exposing Viron boundaries", () => {
    const items = buildDatabaseNavigatorMenu({ kind: "database", database: "billing" });
    expect(items.map((candidate) => candidate.label)).toEqual([
      "关闭数据库",
      "编辑数据库…",
      "新建数据库…",
      "删除数据库",
      "新建查询",
      "命令列界面",
      "运行 SQL 文件…",
      "转储 SQL 文件",
      "数据字典…",
      "在数据库中查找…",
      "共享…",
      "刷新",
    ]);
    expect(item(items, "run-sql-file").disabled).not.toBe(true);
    expect(item(items, "command-line").disabled).not.toBe(true);
    expect(item(items, "dump-database-full").disabled).not.toBe(true);
    expect(() => item(items, "reverse-database")).toThrow("Missing menu item reverse-database");
  });

  it("keeps the Navicat connection menu hierarchy and connection-sensitive actions", () => {
    const disconnected = buildConnectionNavigatorMenu(false);
    expect(disconnected.map((candidate) => candidate.label)).toEqual([
      "关闭连接",
      "切换连接配置文件",
      "编辑连接…",
      "新建连接",
      "删除连接",
      "复制连接…",
      "新建数据库…",
      "新建查询",
      "命令列界面",
      "运行 SQL 文件…",
      "重载",
      "添加星标",
      "颜色",
      "管理组",
      "共享…",
      "刷新",
    ]);
    expect(item(disconnected, "close-connection").disabled).toBe(true);
    expect(item(disconnected, "reload-tables").disabled).toBe(true);

    const connected = buildConnectionNavigatorMenu(true, { profiles: [{ id: "profile-1", name: "Read replica" }], activeProfileId: "profile-1" });
    expect(item(connected, "close-connection").disabled).not.toBe(true);
    expect(item(connected, "reload-tables").disabled).not.toBe(true);
    expect(item(connected, "main-profile").disabled).toBe(true);
    expect(item(connected, "connection-profile:profile-1").label).toContain("Read replica");
    expect(item(connected, "connection-profile:profile-1").disabled).toBe(true);
    expect(() => item(connected, "new-profile")).toThrow("Missing menu item new-profile");

    const closed = buildConnectionNavigatorMenu(false, { profiles: [{ id: "profile-1", name: "Read replica" }], activeProfileId: "profile-1" });
    expect(item(closed, "main-profile").disabled).not.toBe(true);
    expect(item(closed, "connection-profile:profile-1").disabled).not.toBe(true);
  });

  it("disables object-only table commands on a category and enables them for a concrete table", () => {
    const category = buildDatabaseNavigatorMenu({ kind: "category", database: "billing", category: "tables" });
    expect(item(category, "open-object").disabled).toBe(true);
    expect(item(category, "delete-object").disabled).toBe(true);
    expect(item(category, "new-object").disabled).not.toBe(true);
    expect(item(category, "import-table").disabled).not.toBe(true);
    expect(item(category, "analyze-table").disabled).toBe(true);
    expect(item(category, "check-table-normal").disabled).toBe(true);

    const table = buildDatabaseNavigatorMenu({ kind: "object", database: "billing", category: "tables", objectName: "invoices", objectSource: "tables" });
    expect(item(table, "open-object").disabled).not.toBe(true);
    expect(item(table, "delete-object").disabled).not.toBe(true);
    expect(item(table, "duplicate-table-data").disabled).not.toBe(true);
    expect(item(table, "check-table-normal").disabled).not.toBe(true);
    expect(item(table, "repair-table-extended").disabled).not.toBe(true);
    expect(item(table, "open-through-profile:main").disabled).not.toBe(true);
    expect(item(table, "rename-object").disabled).not.toBe(true);
    expect(() => item(table, "reverse-table")).toThrow("Missing menu item reverse-table");
    expect(() => item(table, "create-bi-workspace")).toThrow("Missing menu item create-bi-workspace");
  });

  it("uses the concrete routine type and keeps utility nodes actionable", () => {
    const procedure = buildDatabaseNavigatorMenu({ kind: "object", database: "billing", category: "functions", objectName: "close_month", objectSource: "procedures" });
    expect(item(procedure, "design-object").label).toBe("设计存储过程");
    expect(item(procedure, "run-object").disabled).not.toBe(true);

    const queries = buildDatabaseNavigatorMenu({ kind: "category", database: "billing", category: "queries" });
    expect(item(queries, "new-query").disabled).not.toBe(true);
    expect(item(queries, "design-query").disabled).toBe(true);
    expect(item(queries, "external-editor").disabled).toBe(true);
    expect(item(queries, "open-external-query").disabled).not.toBe(true);

    const query = buildDatabaseNavigatorMenu({ kind: "object", database: "billing", category: "queries", objectId: "query-1", objectName: "Open orders" });
    expect(item(query, "design-query").disabled).not.toBe(true);
    expect(item(query, "delete-query").disabled).not.toBe(true);
    expect(item(query, "duplicate-query").disabled).not.toBe(true);
    expect(item(query, "export-query").disabled).not.toBe(true);
    expect(item(query, "rename-query").disabled).not.toBe(true);
    expect(item(query, "external-editor").disabled).not.toBe(true);
    expect(item(query, "show-query-finder").disabled).not.toBe(true);

    const backups = buildDatabaseNavigatorMenu({ kind: "category", database: "billing", category: "backups" });
    expect(item(backups, "new-backup").disabled).not.toBe(true);
    expect(item(backups, "restore-backup-from").disabled).not.toBe(true);
    expect(item(backups, "show-backup-finder").disabled).toBe(true);
    const backup = buildDatabaseNavigatorMenu({ kind: "object", database: "billing", category: "backups", objectId: "backup-1", objectName: "nightly", objectStatus: "success" });
    expect(item(backup, "show-backup-finder").disabled).not.toBe(true);
  });
});
