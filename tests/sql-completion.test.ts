import { describe, expect, it } from "vitest";
import { sqlCompletionSuggestions, type SqlCompletionContext } from "../src/client/sql-completion.js";

const context: SqlCompletionContext = {
  schemas: ["app-db", "analytics"],
  catalog: {
    database: "app-db",
    objects: [
      {
        name: "dataset",
        type: "table",
        columns: [
          { name: "id", dataType: "char", columnType: "char(32)" },
          { name: "create_time", dataType: "datetime", columnType: "datetime" },
          { name: "data_type", dataType: "tinyint", columnType: "tinyint(4)" },
        ],
      },
      {
        name: "dataset_view",
        type: "view",
        columns: [{ name: "dataset_id", dataType: "char", columnType: "char(32)" }],
      },
    ],
    routines: [{ name: "dataset_count", type: "function" }],
  },
};

function labels(sql: string): string[] {
  return sqlCompletionSuggestions(sql, sql.length, context).map((item) => item.label);
}

describe("Navicat-style SQL completion", () => {
  it("offers SQL syntax, schemas, tables, routines, and parameters while typing", () => {
    const suggestions = sqlCompletionSuggestions("SE", 2, context);
    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "SELECT", kind: "keyword" }),
      expect.objectContaining({ label: "dataset", kind: "table", detail: "app-db" }),
      expect.objectContaining({ label: "dataset_count", kind: "function" }),
      expect.objectContaining({ label: "[$parameter]", kind: "parameter", snippet: true }),
    ]));
    expect(suggestions.find((item) => item.label === "app-db")?.insertText).toBe("`app-db`");
  });

  it("prioritizes database objects after FROM and JOIN", () => {
    const suggestions = sqlCompletionSuggestions("SELECT * FROM dat", "SELECT * FROM dat".length, context);
    expect(suggestions.map((item) => item.kind)).toEqual(["table", "view", "schema", "schema"]);
    expect(suggestions.map((item) => item.label)).toEqual(["dataset", "dataset_view", "app-db", "analytics"]);
  });

  it("resolves aliases and only returns fields after an alias dot", () => {
    const sql = "SELECT * FROM dataset AS d WHERE d.";
    const suggestions = sqlCompletionSuggestions(sql, sql.length, context);
    expect(suggestions.map((item) => item.label)).toEqual(["id", "create_time", "data_type"]);
    expect(suggestions[0]).toMatchObject({ kind: "column", detail: "char(32) · app-db.dataset", filterText: "d.id", insertText: "d.id", replaceQualifier: true });
  });

  it("resolves an alias declared later in the same SELECT statement", () => {
    const sql = "SELECT d. FROM dataset d";
    const offset = sql.indexOf("d.") + 2;
    expect(sqlCompletionSuggestions(sql, offset, context).map((item) => item.label)).toEqual(["id", "create_time", "data_type"]);
  });

  it("offers referenced table fields in WHERE and ORDER clauses", () => {
    const suggestions = sqlCompletionSuggestions("SELECT * FROM dataset d WHERE cr", "SELECT * FROM dataset d WHERE cr".length, context);
    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "create_time", kind: "column", detail: "datetime · d (app-db.dataset)" }),
    ]));
  });

  it("offers objects after a database qualifier", () => {
    expect(labels("SELECT * FROM `app-db`.")).toEqual(["dataset", "dataset_view"]);
  });

  it("keeps completion scoped to the statement containing the cursor", () => {
    const sql = "SELECT * FROM dataset old_alias;\nSELECT * FROM dataset current_alias WHERE current_alias.";
    const suggestions = sqlCompletionSuggestions(sql, sql.length, context);
    expect(suggestions.map((item) => item.label)).toEqual(["id", "create_time", "data_type"]);
  });

  it("reuses named query parameters", () => {
    const sql = "SELECT * FROM dataset WHERE id = [$dataset_id] OR data_type = [$";
    expect(sqlCompletionSuggestions(sql, sql.length, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "[$dataset_id]", kind: "parameter" }),
    ]));
  });
});
