import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseArtifactFileRuntime, databaseArtifactFilename } from "../src/desktop/database-artifact-files.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop database artifact files", () => {
  it("normalizes SQL filenames without allowing path traversal", () => {
    expect(databaseArtifactFilename("../monthly:report.SQL", ".sql", "query")).toBe("monthly_report.sql");
    expect(databaseArtifactFilename("...", "sql", "query")).toBe("query.sql");
  });

  it("materializes query and backup artifacts in app-managed directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viron-database-artifacts-"));
    directories.push(directory);
    const runtime = new DatabaseArtifactFileRuntime(directory);
    const query = await runtime.queryFile("query-1", "Open orders", "SELECT 1;");
    const backup = await runtime.backupFile("backup-1", "billing.sql", new TextEncoder().encode("CREATE TABLE t(id INT);"));

    expect(basename(query)).toBe("query-1-Open orders.sql");
    expect(await readFile(query, "utf8")).toBe("SELECT 1;");
    expect(basename(backup)).toBe("backup-1-billing.sql");
    expect(await readFile(backup, "utf8")).toBe("CREATE TABLE t(id INT);");
  });
});
