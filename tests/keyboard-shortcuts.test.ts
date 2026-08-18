import { describe, expect, it } from "vitest";
import {
  defaultShortcutBindings,
  effectiveShortcutBindings,
  formatShortcutBinding,
  sanitizeShortcutOverrides,
  shortcutActionForInput,
  shortcutBindingFromInput,
  shortcutConflict,
  shortcutOverridesFromBindings,
  shortcutValidationError,
} from "../src/shared/keyboard-shortcuts.js";

describe("keyboard shortcuts", () => {
  it("normalizes macOS and Windows modifier keys", () => {
    expect(shortcutBindingFromInput({ key: "r", meta: true }, "darwin")).toBe("Mod+R");
    expect(shortcutBindingFromInput({ key: "r", control: true }, "win32")).toBe("Mod+R");
    expect(shortcutBindingFromInput({ key: "Enter", meta: true, shift: true }, "darwin")).toBe("Mod+Shift+Enter");
    expect(shortcutBindingFromInput({ key: "r" }, "darwin")).toBeNull();
    expect(shortcutBindingFromInput({ key: "F5" }, "darwin")).toBe("F5");
  });

  it("uses platform-specific defaults for the Agent quick input", () => {
    expect(defaultShortcutBindings("darwin")["app.agentQuickInput"]).toBe("Alt+Space");
    expect(defaultShortcutBindings("win32")["app.agentQuickInput"]).toBe("Mod+Shift+A");
    expect(shortcutActionForInput(defaultShortcutBindings("darwin"), { key: " ", alt: true }, "darwin")).toBe("app.agentQuickInput");
    expect(shortcutActionForInput(defaultShortcutBindings("darwin"), { key: "\u00a0", alt: true }, "darwin")).toBe("app.agentQuickInput");
    expect(shortcutActionForInput(defaultShortcutBindings("win32"), { key: "a", control: true, shift: true }, "win32")).toBe("app.agentQuickInput");
  });

  it("resolves actions from effective overrides and preserves disabled bindings", () => {
    const bindings = effectiveShortcutBindings({ "workspace.refresh": "Mod+Shift+R", "workspace.close": "" });
    expect(shortcutActionForInput(bindings, { key: "d", meta: true }, "darwin")).toBe("workspace.design");
    expect(shortcutActionForInput(bindings, { key: "d", control: true }, "win32")).toBe("workspace.design");
    expect(shortcutActionForInput(bindings, { key: "r", meta: true, shift: true }, "darwin")).toBe("workspace.refresh");
    expect(shortcutActionForInput(bindings, { key: "w", meta: true }, "darwin")).toBeNull();
    expect(shortcutOverridesFromBindings(bindings)).toMatchObject({ "workspace.refresh": "Mod+Shift+R", "workspace.close": "" });
  });

  it("rejects reserved bindings and reports conflicts", () => {
    const bindings = defaultShortcutBindings();
    expect(shortcutValidationError("Mod+C")).toContain("保留");
    expect(shortcutValidationError("R")).toContain("必须包含");
    expect(shortcutValidationError("Alt+Space", "win32")).toContain("Windows");
    expect(shortcutValidationError("Alt+Space", "darwin")).toBe("");
    expect(shortcutConflict(bindings, "workspace.new", "Mod+R")?.id).toBe("workspace.refresh");
  });

  it("sanitizes stored values and formats native labels", () => {
    expect(sanitizeShortcutOverrides({ "workspace.refresh": "Mod+Shift+R", bad: "Mod+K", "workspace.save": 12 })).toEqual({ "workspace.refresh": "Mod+Shift+R" });
    expect(formatShortcutBinding("Mod+Shift+R", "darwin")).toBe("⌘⇧R");
    expect(formatShortcutBinding("Mod+Shift+R", "win32")).toBe("Ctrl+Shift+R");
    expect(formatShortcutBinding("", "darwin")).toBe("未设置");
  });
});
