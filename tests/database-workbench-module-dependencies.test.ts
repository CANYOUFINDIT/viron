import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const navigator = readFileSync(
  new URL("../src/client/components/database-workbench/use-database-navigator.ts", import.meta.url),
  "utf8",
);
const navigatorActions = readFileSync(
  new URL("../src/client/components/database-workbench/database-navigator-actions.ts", import.meta.url),
  "utf8",
);

describe("database workbench module dependency contracts", () => {
  it("keeps navigator state and action modules within the refactor size target", () => {
    expect(navigator.split("\n").length).toBeLessThanOrEqual(800);
    expect(navigatorActions.split("\n").length).toBeLessThanOrEqual(800);
  });

  it("keeps navigator actions stateless and independent from sibling composables", () => {
    expect(navigatorActions).toContain("createDatabaseNavigatorActions(ctx: DatabaseWorkbenchContext)");
    expect(navigatorActions).not.toMatch(/from\s+["']\.\/use-/);
    expect(navigatorActions).not.toMatch(/\b(?:ref|computed|reactive|shallowRef)\s*\(/);
    expect(navigator).toContain('from "./database-navigator-actions"');
  });
});
