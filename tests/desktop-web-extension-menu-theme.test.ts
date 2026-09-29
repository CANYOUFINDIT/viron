import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(new URL("../src/client/components/DesktopWebAccountBrowser.vue", import.meta.url), "utf8");

describe("desktop Web extension menu themes", () => {
  it("uses shared theme tokens for menu surfaces and highlights", () => {
    expect(component).toContain("--extension-menu-surface: var(--color-paper-raised, var(--surface));");
    expect(component).toContain("--extension-menu-highlight: var(--color-paper-muted, var(--ink-50));");
    expect(component).toContain("--extension-menu-border: var(--color-rule, var(--ink-100));");
    expect(component).toContain(".desktop-web-extension-list-popper.el-popper {");
    expect(component).toContain("background: var(--color-paper-raised, var(--surface));");
  });

  it("does not fall back to light-only colors in the extension menu", () => {
    const menuStyles = component.slice(component.indexOf(".desktop-web-extensions {"));

    expect(menuStyles).not.toContain("var(--surface-50");
    expect(menuStyles).not.toContain("var(--surface-100");
    expect(menuStyles).not.toContain("var(--line-200");
    expect(menuStyles).not.toContain("background: #fff;");
  });
});
