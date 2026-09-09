import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pane = readFileSync(new URL("../src/client/components/RedisWorkbench.vue", import.meta.url), "utf8");

describe("Redis workbench selected rows", () => {
  it("marks the selected connection with a fill instead of a framed card or left rail", () => {
    expect(pane).toContain(".redis-connection-list section > button.is-active { background: var(--teal-50); color: var(--teal-700); }");
    expect(pane).toContain(".redis-connection-list section > button.is-active .redis-connection-icon { border-color: color-mix(in srgb, var(--teal-500) 32%, var(--ink-200)); color: var(--teal-700); }");
    expect(pane).toContain(".redis-connection-list section > button:focus-visible { outline: 2px solid var(--teal-500); outline-offset: -2px; }");
    expect(pane).not.toContain("box-shadow: inset 2px 0 var(--teal-500)");
    expect(pane).not.toContain("box-shadow: inset 3px 0 var(--teal-500)");
  });
});
