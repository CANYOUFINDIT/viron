import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return vueFiles(path);
    return entry.name.endsWith(".vue") ? [path] : [];
  });
}

function dialogBlocks(content: string): string[] {
  const blocks: string[] = [];
  const starts: number[] = [];
  for (const match of content.matchAll(/<\/?el-dialog\b[^>]*>/g)) {
    if (!match[0].startsWith("</")) {
      starts.push(match.index);
      continue;
    }
    const start = starts.pop();
    if (start !== undefined) blocks.push(content.slice(start, match.index + match[0].length));
  }
  return blocks;
}

describe("unified dialog presentation", () => {
  const styles = source("src/client/styles/base.css");

  it("uses one theme-aware shell for standard and confirmation dialogs", () => {
    expect(styles).toContain(".el-dialog.el-dialog {");
    expect(styles).toContain("border-radius: 16px;");
    expect(styles).toContain("background: var(--viron-dialog-surface);");
    expect(styles).toContain(".el-message-box {");
    expect(styles).toContain("--el-button-bg-color: var(--color-accent-strong, var(--teal-700));");
  });

  it("centers confirmation prompts with an icon, title, copy and equal-width actions", () => {
    expect(styles).toContain(".el-message-box__content,");
    expect(styles).toContain(".el-message-box__container {");
    expect(styles).toContain("display: contents;");
    expect(styles).toContain(".el-message-box__status {");
    expect(styles).toContain("flex-direction: row-reverse;");
    expect(styles).toContain(".el-message-box__btns .el-button {");
    expect(styles).toContain("flex: 1 1 0;");
    expect(styles).toContain("border-radius: 999px;");
    expect(styles).toContain("--viron-button-halo: var(--el-button-bg-color, var(--color-accent-strong));");
    expect(styles).toContain("0 12px 24px color-mix(in srgb, var(--viron-button-halo) 38%, transparent);");
    expect(styles).toContain(".el-message-box__btns .el-button:hover {");
    expect(styles).toContain("--viron-button-halo: var(--ink-500);");
    expect(styles).not.toMatch(/\.el-message-box__btns \.el-button:not\(\.el-button--primary\):not\(\.el-button--danger\) \{[^}]*box-shadow:\s*none/);
    expect(styles).toContain(".el-overlay.is-message-box .el-overlay-message-box,");
    expect(styles).toContain("justify-content: center;");
    expect(styles).toContain("display: inline-flex;");
    expect(styles).not.toContain("0 0 0 7px");
  });

  it("removes header close controls and splits cancel from primary actions", () => {
    expect(styles).toContain(".el-message-box .el-message-box__headerbtn {");
    expect(styles).toMatch(/\.el-message-box \.el-message-box__headerbtn \{\s+display: none;/);
    expect(styles).toContain(".el-dialog__footer > .el-button:first-of-type {");
    expect(styles).toContain("margin-inline-end: auto;");
  });

  it("gives every Element Plus dialog an explicit footer close path", () => {
    const dialogs = vueFiles(resolve(process.cwd(), "src/client"))
      .flatMap((file) => dialogBlocks(readFileSync(file, "utf8")));

    expect(dialogs.length).toBeGreaterThan(50);
    expect(dialogs.every((dialog) => dialog.includes("#footer"))).toBe(true);
  });

  it("keeps the main sidebar below overlays and does not trap them in the page surface", () => {
    expect(styles).toContain("--z-app-sidebar:");
    expect(styles).toContain("--z-app-sidebar-scrim:");
    expect(styles).toContain("--z-app-window-header:");
    expect(styles).toMatch(/\.app-sidebar \{[^}]*z-index:\s*var\(--z-app-sidebar\)/);
    expect(styles).not.toMatch(/\.app-surface \{[^}]*z-index\s*:/);
    const sidebar = Number(styles.match(/--z-app-sidebar:\s*(\d+)/)?.[1]);
    const scrim = Number(styles.match(/--z-app-sidebar-scrim:\s*(\d+)/)?.[1]);
    const header = Number(styles.match(/--z-app-window-header:\s*(\d+)/)?.[1]);
    expect(sidebar).toBeGreaterThan(scrim);
    expect(scrim).toBeGreaterThan(header);
    expect(sidebar).toBeLessThan(2000);
  });

  it("teleports every Element Plus dialog and drawer above the app shell", () => {
    const clientRoot = resolve(process.cwd(), "src/client");
    const files = vueFiles(clientRoot).map((file) => readFileSync(file, "utf8"));
    const dialogs = files.flatMap((content) => dialogBlocks(content));
    const drawers = files.flatMap((content) => content.match(/<el-drawer\b[^>]*>/gs) ?? []);

    expect(dialogs.length).toBeGreaterThan(50);
    expect(dialogs.every((dialog) => /\bappend-to-body\b/.test(dialog))).toBe(true);
    expect(drawers.length).toBeGreaterThan(0);
    expect(drawers.every((drawer) => /\bappend-to-body\b/.test(drawer))).toBe(true);
  });

  it("keeps exceptional multi-action footers cancel-first", () => {
    expect(source("src/client/components/DatabaseDataGeneratorDialog.vue")).toContain('<template #footer><el-button @click="emit(\'close\')">{{ $t(\'取消\') }}');
    expect(source("src/client/components/DatabaseQueryBuilderDialog.vue")).toContain('<template #footer><el-button @click="emit(\'close\')">{{ $t(\'取消\') }}');
    expect(source("src/client/components/DatabaseSyncDialog.vue")).toContain('<div class="sync-dialog-footer"><el-button @click="emit(\'close\')">{{ $t(\'取消\') }}');
    expect(source("src/client/components/DatabaseBiWorkspace.vue")).toContain('<template #footer><el-button @click="sourceDialog = false">{{ $t(\'取消\') }}');
  });
});
