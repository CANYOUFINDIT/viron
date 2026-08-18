import { afterEach, describe, expect, it } from "vitest";
import { currentAgentDatabaseScene, fillAgentDatabaseSql, registerAgentDatabaseSceneProvider } from "../src/client/agent-database-scene.js";

let release: (() => void) | undefined;
afterEach(() => { release?.(); release = undefined; });

describe("AI Agent database workbench scene", () => {
  it("binds SQL fill to the visible local connection and database", () => {
    const filled: string[] = [];
    release = registerAgentDatabaseSceneProvider({
      current: () => ({ routePath: "/database", connectionId: "c1", connectionName: "db", database: "app", connected: true, localExecution: true, editorSql: "", selectedSql: "", resultPreview: [] }),
      fill: (_connectionId, _database, sql) => { filled.push(sql); return true; },
    });
    expect(currentAgentDatabaseScene("/database")?.database).toBe("app");
    expect(fillAgentDatabaseSql("/database", "c1", "app", "SELECT 1")).toBe(true);
    expect(fillAgentDatabaseSql("/database", "c1", "other", "SELECT 1")).toBe(false);
    expect(fillAgentDatabaseSql("/other", "c1", "app", "SELECT 1")).toBe(false);
    expect(filled).toEqual(["SELECT 1"]);
  });
});
