import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/client/clipboard.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function createLegacyDocument(copyResult = true) {
  const previousFocus = { focus: vi.fn() };
  const textarea = {
    value: "",
    style: { cssText: "" },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const documentRef = {
    activeElement: previousFocus,
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => copyResult),
  } as unknown as Document;
  return { documentRef, previousFocus, textarea };
}

describe("clipboard copy", () => {
  it("uses the Clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(copyTextToClipboard("hello", {
      secureContext: true,
      clipboard: { writeText },
      document: null,
    })).resolves.toBe("clipboard-api");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand for an insecure HTTP page", async () => {
    const { documentRef, previousFocus, textarea } = createLegacyDocument();

    await expect(copyTextToClipboard("selected output", {
      secureContext: false,
      clipboard: null,
      document: documentRef,
    })).resolves.toBe("exec-command");
    expect(textarea.value).toBe("selected output");
    expect(documentRef.execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(previousFocus.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("falls back when the Clipboard API rejects the write", async () => {
    const { documentRef } = createLegacyDocument();
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));

    await expect(copyTextToClipboard("hello", {
      secureContext: true,
      clipboard: { writeText },
      document: documentRef,
    })).resolves.toBe("exec-command");
  });

  it("reports failure when neither copy method succeeds", async () => {
    const { documentRef } = createLegacyDocument(false);

    await expect(copyTextToClipboard("hello", {
      secureContext: false,
      clipboard: null,
      document: documentRef,
    })).rejects.toThrow("Clipboard API unavailable");
  });

  it("connects the desktop terminal to the trusted native clipboard bridge", () => {
    const preload = source("src/desktop/preload.cts");
    const main = source("src/desktop/main.ts");
    const terminal = source("src/client/components/SshTerminalPane.vue");

    expect(preload).toContain('ipcRenderer.invoke("viron:clipboard:read-text")');
    expect(preload).toContain('ipcRenderer.invoke("viron:clipboard:write-text", value)');
    expect(main).toContain('ipcMain.handle("viron:clipboard:read-text", (event) => {\n    trustedSender(event);');
    expect(main).toContain('ipcMain.handle("viron:clipboard:write-text", (event, value: unknown) => {\n    trustedSender(event);');
    expect(terminal).toContain("terminal.onSelectionChange(scheduleSelectionCopy)");
    expect(terminal).toContain("await writeDesktopClipboardText(selection)");
    expect(terminal).toContain("terminal.paste(value)");
    expect(terminal).toContain('@contextmenu="pasteClipboardOnContextMenu"');
  });
});
