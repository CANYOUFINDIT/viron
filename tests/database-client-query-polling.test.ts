/** @vitest-environment happy-dom */
import { effectScope, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/client/api")>(),
  api: vi.fn(),
}));
import { api } from "../src/client/api";
import { createDatabaseWorkbenchContext } from "../src/client/components/database-workbench/context";
import { useDatabaseQueryTabs } from "../src/client/components/database-workbench/use-database-query-tabs";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function setup() {
  const ctx = createDatabaseWorkbenchContext();
  ctx.connections = { selectedConnectionId: ref("fixture"), databaseConnected: ref(true) } as typeof ctx.connections;
  ctx.navigator = { selectedDatabase: ref("fixture") } as typeof ctx.navigator;
  const loadHistory = vi.fn().mockRejectedValue(new Error("History unavailable"));
  ctx.artifacts = { loadHistory } as typeof ctx.artifacts;
  const scope = effectScope();
  const queries = scope.run(() => useDatabaseQueryTabs(ctx, { active: true }, { fullPath: "/database" }, () => {}))!;
  ctx.queryTabs = queries;
  return { scope, queries, loadHistory, tab: queries.newTab("SELECT 1", "fixture") };
}

describe("database client query polling", () => {
  it("reads immediately without overlapping slow requests, and preserves successful results if history fails", async () => {
    vi.useFakeTimers();
    const { scope, queries, tab, loadHistory } = setup();
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((done) => { resolve = done; }));
    queries.pollJob(tab, "job");
    expect(api).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_050);
    expect(api).toHaveBeenCalledOnce();
    resolve({ job: { id: "job", status: "success", resultSets: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.job?.status).toBe("success");
    expect(loadHistory).toHaveBeenCalledOnce();
    expect(queries.pollTimers.size).toBe(0);
    scope.stop();
  });

  it("does not fetch a query that already completed in the start response", async () => {
    vi.useFakeTimers();
    const { scope, queries, tab } = setup();
    vi.mocked(api).mockResolvedValue({ job: { id: "job", status: "success", resultSets: [] } });
    await queries.runQuery(undefined, tab);
    await vi.advanceTimersByTimeAsync(700);
    expect(api).toHaveBeenCalledOnce();
    expect(tab.job?.status).toBe("success");
    expect(queries.pollTimers.size).toBe(0);
    scope.stop();
  });

  it("ignores results arriving after polling was disposed", async () => {
    vi.useFakeTimers();
    const { scope, queries, tab } = setup();
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((done) => { resolve = done; }));
    queries.pollJob(tab, "job");
    for (const timer of queries.pollTimers) window.clearInterval(timer);
    queries.pollTimers.clear();
    resolve({ job: { id: "job", status: "success", resultSets: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.job).toBeNull();
    scope.stop();
  });
});
