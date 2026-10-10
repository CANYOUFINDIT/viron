import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitiveSshCommand } from "../src/client/ssh-command-history";
import { SshTerminalRenderedCommandTracker } from "../src/client/ssh-terminal-rendered-command";

const terminals: Terminal[] = [];
afterEach(() => terminals.splice(0).forEach((terminal) => terminal.dispose()));

function fixture(cols = 100, rows = 5) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: false });
  terminals.push(terminal);
  const tracker = new SshTerminalRenderedCommandTracker(terminal);
  const write = async (text: string) => {
    await new Promise<void>((resolve) => terminal.write(text, resolve));
    return tracker.observe();
  };
  return { terminal, tracker, write };
}

describe("SSH rendered command capture", () => {
  it("records the completed command after delayed remote echo, keeping its submission directory", async () => {
    const { tracker, write } = fixture();
    expect((await write("(base) root@fixture:/srv# ")).prompt).toBe("(base) root@fixture:/srv# ");
    await write("cd /o");
    expect(tracker.submit("/srv")).toBe(true);
    expect((await write("pt/")).submission).toBeUndefined();
    expect((await write("\x1b[?2004l\r\nroot@fixture:/opt# ")).submission).toEqual({ command: "cd /opt/", cwd: "/srv" });
    expect(tracker.observe().submission).toBeUndefined();
  });

  it("captures recalled commands and edits applied by readline", async () => {
    const { tracker, write } = fixture();
    await write("user@fixture:~$ ");
    await write("\r\x1b[2Kuser@fixture:~$ echo old\b\b\b\x1b[Knew");
    tracker.submit("~");
    expect((await write("\r\nnew\r\nuser@fixture:~$ ")).submission).toEqual({ command: "echo new", cwd: "~" });
  });

  it("captures the redrawn command after tab completion lists candidates", async () => {
    const { tracker, write } = fixture();
    await write("root@fixture:/srv# ");
    await write("cd /s\x07\r\nsrv/  shared/\r\nroot@fixture:/srv# cd /srv/");
    tracker.submit("/srv");
    expect((await write("\r\nroot@fixture:/srv# ")).submission).toEqual({ command: "cd /srv/", cwd: "/srv" });
  });

  it("keeps wrapped commands intact when the viewport scrolls", async () => {
    const { tracker, write } = fixture(24, 3);
    await write("user@fixture:~$ ");
    const command = "cat /srv/application/configuration/example.conf";
    await write(command);
    tracker.submit("~");
    expect((await write("\r\nresult\r\nuser@fixture:~$ ")).submission).toEqual({ command, cwd: "~" });
  });

  it("joins wrapped prompts and preserves CJK paths", async () => {
    const { tracker, write } = fixture(24);
    await write("(base) user@fixture:/srv/application# ");
    await write("cd 中文目录/");
    tracker.submit("/srv/application");
    expect((await write("\r\n")).submission).toEqual({ command: "cd 中文目录/", cwd: "/srv/application" });
  });

  it("preserves leading spaces and sensitive arguments for the history privacy filter", async () => {
    const { tracker, write } = fixture();
    await write("root@fixture:/srv# ");
    await write(" echo hidden");
    tracker.submit("/srv");
    const hidden = (await write("\r\nroot@fixture:/srv# ")).submission;
    expect(hidden?.command).toBe(" echo hidden");
    expect(isSensitiveSshCommand(hidden!.command)).toBe(true);
    await write("export API_TOKEN=fixture-token");
    tracker.submit("/srv");
    const secret = (await write("\r\n")).submission;
    expect(isSensitiveSshCommand(secret!.command)).toBe(true);
  });

  it("does not capture password input or alternate-screen programs", async () => {
    const { tracker, write } = fixture();
    await write("Password: ");
    expect(tracker.submit("/srv")).toBe(false);
    expect((await write("fixture-password\r\n")).submission).toBeUndefined();
    await write("root@fixture:/srv# ");
    await write("vim example.conf");
    tracker.submit("/srv");
    expect((await write("\x1b[?1049hfull-screen input\r\n")).submission).toBeUndefined();
    expect(tracker.submit("/srv")).toBe(false);
  });

  it("drops pending captures when reconnecting", async () => {
    const { tracker, write } = fixture();
    await write("root@fixture:/srv# ls");
    expect(tracker.submit("/srv")).toBe(false);
    await write("\r\nroot@fixture:/srv# ");
    await write("ls");
    tracker.submit("/srv");
    tracker.reset();
    expect((await write("\r\n")).submission).toBeUndefined();
  });
});
