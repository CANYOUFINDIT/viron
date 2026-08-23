import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { agentEntryMode, type AgentEntryMode } from "../shared/agent.js";
import type { DesktopExecutionMode } from "../shared/execution-mode.js";
import type { Language } from "../shared/i18n.js";
import {
  effectiveShortcutBindings,
  parseShortcutBinding,
  sanitizeShortcutOverrides,
  type ShortcutOverrides,
} from "../shared/keyboard-shortcuts.js";
import type { McpApprovalMode } from "../shared/mcp-settings.js";

export interface DesktopStateFile {
  language?: Language;
  recentEndpoint?: string;
  agentEntryMode?: AgentEntryMode;
  executionModes?: Record<string, DesktopExecutionMode>;
  executionScopes?: Record<string, string>;
  localMcpEnabled?: boolean;
  localMcpApprovalMode?: McpApprovalMode;
  systemKeyAccessConsentVersion?: number;
  shortcutOverrides?: ShortcutOverrides;
  webLastUrls?: Record<string, string>;
}

export function statePath(): string {
  return join(app.getPath("userData"), "desktop-state.json");
}

export function readState(): DesktopStateFile {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as DesktopStateFile;
  } catch {
    return {};
  }
}

export function writeState(state: DesktopStateFile): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function shortcutPreferences() {
  const overrides = sanitizeShortcutOverrides(readState().shortcutOverrides);
  return { overrides, bindings: effectiveShortcutBindings(overrides, process.platform) };
}

export function currentAgentEntryMode(): AgentEntryMode {
  return agentEntryMode(readState().agentEntryMode);
}

export function electronAccelerator(binding: string): string | undefined {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return undefined;
  const modifiers = parsed.modifiers.map((modifier) => modifier === "Mod" ? "CommandOrControl" : modifier);
  return [...modifiers, parsed.key].join("+");
}
