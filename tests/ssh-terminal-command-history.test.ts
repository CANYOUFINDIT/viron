/** @vitest-environment happy-dom */
import type { Terminal } from "@xterm/xterm";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18nPlugin } from "../src/client/i18n";

const state = vi.hoisted(() => ({
  terminal: null as Terminal | null,
  onOutput: null as ((event: { sessionId: string; type: "output"; data: Uint8Array }) => void) | null,
}));

// Use xterm's real parser and buffer, without mounting its canvas renderer.
vi.mock("@xterm/xterm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xterm/xterm")>();
  return { ...original, Terminal: class extends original.Terminal {
    constructor(options: ConstructorParameters<typeof original.Terminal>[0]) {
      super(options);
      state.terminal = this;
    }
    open() {}
    focus() {}
  } };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate() {} dispose() {} fit() {} } }));
vi.mock("../src/client/theme", async () => {
  const { ref } = await import("vue");
  return { theme: ref("dark"), consoleUsesLightPalette: () => false };
});
vi.mock("../src/client/desktop", () => ({
  attachDesktopSshSession: vi.fn(async () => ({ output: "" })),
  detachDesktopSshSession: vi.fn(async () => undefined),
  isDesktopApp: () => false,
  onDesktopSshSessionEvent: (callback: typeof state.onOutput) => { state.onOutput = callback; return () => { state.onOutput = null; }; },
  readDesktopClipboardText: vi.fn(),
  resizeDesktopSshSession: vi.fn(async () => undefined),
  sendDesktopSshBinary: vi.fn(async () => undefined),
  sendDesktopSshInput: vi.fn(async () => undefined),
}));
vi.mock("../src/client/service-socket", () => ({ ServiceSocket: class { static OPEN = 1; } }));

import SshTerminalPane from "../src/client/components/SshTerminalPane.vue";

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  state.terminal = null;
});

async function fixture() {
  const wrapper = mount(SshTerminalPane, {
    props: { sessionId: "fixture-session", ticket: "fixture-ticket", localExecution: true, status: "connected" },
    global: { plugins: [i18nPlugin] },
  });
  wrappers.push(wrapper);
  await flushPromises();
  const terminal = state.terminal!;
  const output = async (text: string) => {
    state.onOutput!({ sessionId: "fixture-session", type: "output", data: new TextEncoder().encode(text) });
    await new Promise<void>((resolve) => terminal.write("", resolve));
    await flushPromises();
  };
  await output("(base) root@fixture:/srv# ");
  return { wrapper, terminal, output };
}

describe("SSH pane command history events", () => {
  it("emits completed commands and continues recording in the new directory", async () => {
    const { wrapper, terminal, output } = await fixture();
    terminal.input("cd /o\t");
    await output("cd /o");
    terminal.input("\r");
    expect(wrapper.emitted("commandSubmitted")).toBeUndefined();
    await output("pt/\r\n(base) root@fixture:/opt# ");
    terminal.input("ls\r");
    expect(wrapper.emitted("commandSubmitted")).toEqual([
      [{ command: "cd /opt/", cwd: "/srv" }],
      [{ command: "ls", cwd: "/opt" }],
    ]);
  });

  it("records shell history recall once and skips subsequent password input", async () => {
    const { wrapper, terminal, output } = await fixture();
    terminal.input("\x1b[A");
    await output("sudo whoami");
    terminal.input("\r");
    await output("\r\n[sudo] password for fixture: ");
    terminal.input("fixture-password\r");
    await output("\r\nroot\r\n(base) root@fixture:/srv# ");
    expect(wrapper.emitted("commandSubmitted")).toEqual([[{ command: "sudo whoami", cwd: "/srv" }]]);
  });

  it("keeps multiline bracketed paste out of history even after Enter", async () => {
    const { wrapper, terminal, output } = await fixture();
    terminal.input("\x1b[200~echo first\necho second\x1b[201~");
    await output("echo first\r\necho second");
    terminal.input("\r");
    await output("\r\nfirst\r\nsecond\r\n(base) root@fixture:/srv# ");
    expect(wrapper.emitted("commandSubmitted")).toBeUndefined();
  });
});
