import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("desktop title bar layout", () => {
  const shell = source("src/client/components/AppShell.vue");
  const styles = source("src/client/styles/base.css");
  const main = source("src/desktop/main.ts");

  it("reserves the Windows overlay and exposes a drag region", () => {
    expect(shell).toContain("'is-desktop': desktop");
    expect(shell).toContain('<header v-if="desktop" class="desktop-window-header"');
    expect(styles).toMatch(/\.app-frame\.is-desktop\s*{[^}]*--desktop-window-header-height:\s*36px;/s);
    expect(styles).toContain(".is-desktop .app-content { min-height: var(--desktop-usable-viewport-height); }");
    expect(styles).toContain(".is-desktop .app-content.is-workbench-page {");
    expect(styles).toContain(".is-desktop.is-immersive .standalone-workbench { height: var(--desktop-usable-viewport-height); }");
    expect(styles).toContain("-webkit-app-region: drag;");
    expect(main).toContain('titleBarOverlay: desktopTitleBarOverlay("login")');
  });

  it("keeps the larger macOS title bar and traffic-light safe area", () => {
    expect(styles).toMatch(/\.app-frame\.is-macos-desktop\s*{[^}]*--app-titlebar-safe-area:\s*28px;[^}]*--desktop-window-header-height:\s*46px;/s);
  });
});
