import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/client/styles/base.css", import.meta.url), "utf8");
const pane = readFileSync(new URL("../src/client/components/SshTerminalPane.vue", import.meta.url), "utf8");

describe("ssh terminal styles", () => {
  it("keeps xterm leftover space on the themed shell instead of a black viewport strip", () => {
    expect(styles).toContain(".ssh-terminal-shell { min-width: 0; min-height: 0; position: relative; overflow: hidden; background: #081214; padding: 7px 5px 4px 9px; }");
    expect(styles).toContain(".ssh-terminal-pane { width: 100%; height: 100%; min-width: 0; min-height: 0; background: #081214; overflow: hidden; }");
    expect(styles).not.toContain(".ssh-terminal-pane { width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 7px 5px 4px 9px; background: #081214; overflow: hidden; }");
    expect(styles).toContain(".ssh-terminal-pane .xterm .xterm-viewport,");
    expect(styles).toContain(".ssh-terminal-pane .xterm .xterm-scrollable-element { background-color: transparent !important; }");
    expect(styles).toContain(".ssh-terminal-pane .xterm .xterm-viewport { overflow: hidden !important; scrollbar-width: thin; scrollbar-color: #29423c transparent; }");
    expect(styles).toContain(":root.bright .ssh-terminal-shell,");
    expect(styles).toContain(":root.bright .ssh-terminal-pane { background: #fbfcfd; }");
  });

  it("repaints the lazily loaded xterm viewport so its default black background cannot win", () => {
    expect(pane).toContain("function paintTerminalChrome()");
    expect(pane).toContain("viewport.style.backgroundColor = \"transparent\"");
    expect(pane).toContain("viewport.style.overflow = \"hidden\"");
    expect(pane).toContain("paintTerminalChrome();");
    expect(pane).toContain(".ssh-terminal-pane :deep(.xterm-viewport) { overflow: hidden !important; }");
    expect(pane).toContain("background-color: transparent !important;");
  });
});
