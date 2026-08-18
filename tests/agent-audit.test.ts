import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAgentAuditStore } from "../src/desktop/agent-audit.js";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("AI Agent local audit", () => {
  it("isolates records by Endpoint and user and clears only the current scope", () => {
    const path = mkdtempSync(join(tmpdir(), "viron-agent-audit-")); paths.push(path);
    const store = new DesktopAgentAuditStore(path);
    const one = { vironEndpoint: "https://one.test", vironUserId: "u1" };
    const two = { vironEndpoint: "https://two.test", vironUserId: "u2" };
    store.append(one, "database_context_read", "c1:app", "读取数据库现场");
    store.append(two, "database_context_read", "c2:app", "读取数据库现场");
    expect(store.clear(one)).toEqual({ cleared: 1 });
    const records = JSON.parse(readFileSync(join(path, "ai-agent-audit.json"), "utf8"));
    expect(records).toHaveLength(1);
    expect(records[0].target).toBe("c2:app");
  });
});
