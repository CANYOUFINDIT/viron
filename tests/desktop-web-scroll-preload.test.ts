import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function preload(sendSync: (channel: string, id: string, bounds: unknown) => unknown) {
  let bridge!: { syncWebViewBounds(id: string, bounds: unknown): void };
  runInNewContext(code, {
    exports: {},
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
      ipcRenderer: { sendSync },
    }),
  });
  return bridge;
}

describe("native web scroll preload", () => {
  it("finishes the native move before returning control to the renderer", () => {
    let nativeY = 312;
    const bridge = preload((_channel, _id, bounds) => {
      nativeY = (bounds as { y: number }).y;
      return null;
    });
    bridge.syncWebViewBounds("page", { x: 80, y: 296, width: 1000, height: 700 });
    expect(nativeY).toBe(296);
  });

  it("reports rejected or closed views so the renderer can retry a later layout", () => {
    const bridge = preload(() => ({ error: "Page closed" }));
    expect(() => bridge.syncWebViewBounds("page", {})).toThrow("Page closed");
  });
});
