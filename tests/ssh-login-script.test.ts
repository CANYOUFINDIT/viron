import { describe, expect, it } from "vitest";
import { editLoginScriptIndent } from "../src/client/ssh-login-script.js";
import { normalizeSshLoginScript } from "../src/server/ssh/options.js";

describe("SSH login script editing", () => {
  it("inserts two-space indentation at the caret", () => {
    expect(editLoginScriptIndent("echo ready", 5, 5, false)).toEqual({
      value: "echo   ready",
      selectionStart: 7,
      selectionEnd: 7,
    });
  });

  it("indents and outdents complete selected lines", () => {
    const script = "cd /srv\nexport APP_ENV=prod\ngit status";
    const indented = editLoginScriptIndent(script, 0, script.length, false);
    expect(indented.value).toBe("  cd /srv\n  export APP_ENV=prod\n  git status");
    expect(indented.selectionStart).toBe(0);
    expect(indented.selectionEnd).toBe(indented.value.length);

    const outdented = editLoginScriptIndent(indented.value, indented.selectionStart, indented.selectionEnd, true);
    expect(outdented.value).toBe("cd /srv\nexport APP_ENV=prod\ngit status");
  });

  it("normalizes pasted line endings and adds only a missing final newline", () => {
    expect(normalizeSshLoginScript("cd /srv\r\nexport APP_ENV=prod\rprintf ready")).toBe(
      "cd /srv\nexport APP_ENV=prod\nprintf ready\n",
    );
    expect(normalizeSshLoginScript("echo ready\n\n")).toBe("echo ready\n\n");
  });
});
