export type ShortcutActionId =
  | "app.settings"
  | "app.agentQuickInput"
  | "workspace.search"
  | "workspace.new"
  | "workspace.design"
  | "workspace.close"
  | "workspace.save"
  | "workspace.refresh"
  | "workspace.execute";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  group: "application" | "workbench";
  label: string;
  defaultBinding: string;
  platformDefaultBindings?: Partial<Record<"darwin" | "win32", string>>;
  settingsSection?: "shortcuts" | "ai-agent";
}

export type ShortcutBindings = Record<ShortcutActionId, string>;
export type ShortcutOverrides = Partial<Record<ShortcutActionId, string>>;

export interface ShortcutInput {
  key: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: "app.settings", group: "application", label: "打开设置", defaultBinding: "Mod+," },
  {
    id: "app.agentQuickInput",
    group: "application",
    label: "唤起 Viron Agent 快捷输入",
    defaultBinding: "Alt+Space",
    platformDefaultBindings: { darwin: "Alt+Space", win32: "Mod+Shift+A" },
    settingsSection: "ai-agent",
  },
  { id: "workspace.search", group: "workbench", label: "搜索当前内容", defaultBinding: "Mod+F" },
  { id: "workspace.new", group: "workbench", label: "新建当前对象", defaultBinding: "Mod+N" },
  { id: "workspace.design", group: "workbench", label: "设计当前对象", defaultBinding: "Mod+D" },
  { id: "workspace.close", group: "workbench", label: "关闭当前页签", defaultBinding: "Mod+W" },
  { id: "workspace.save", group: "workbench", label: "保存或提交", defaultBinding: "Mod+S" },
  { id: "workspace.refresh", group: "workbench", label: "刷新当前内容", defaultBinding: "Mod+R" },
  { id: "workspace.execute", group: "workbench", label: "执行当前内容", defaultBinding: "Mod+Enter" },
];

const definitionIds = new Set(SHORTCUT_DEFINITIONS.map((item) => item.id));
const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);
const reservedBindings = new Set([
  "Mod+A",
  "Mod+C",
  "Mod+H",
  "Mod+M",
  "Mod+Q",
  "Mod+V",
  "Mod+X",
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+Shift+W",
  "Mod+Space",
  "Mod+Tab",
  "Alt+Tab",
]);

function runtimeShortcutPlatform(): string {
  if (typeof navigator !== "undefined") return /Macintosh|Mac OS X/.test(navigator.userAgent) ? "darwin" : "win32";
  if (typeof process !== "undefined") return process.platform;
  return "win32";
}

function normalizedKey(key: string): string {
  if (key === " " || key === "\u00a0") return "Space";
  if (key === "Esc") return "Escape";
  if (key.length === 1) return key.toUpperCase();
  return key.length ? `${key[0].toUpperCase()}${key.slice(1)}` : "";
}

export function shortcutDefaultBinding(definition: ShortcutDefinition, platform: NodeJS.Platform | string = runtimeShortcutPlatform()): string {
  return definition.platformDefaultBindings?.[platform === "darwin" ? "darwin" : "win32"] ?? definition.defaultBinding;
}

export function defaultShortcutBindings(platform: NodeJS.Platform | string = runtimeShortcutPlatform()): ShortcutBindings {
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map((item) => [item.id, shortcutDefaultBinding(item, platform)])) as ShortcutBindings;
}

export function effectiveShortcutBindings(overrides: ShortcutOverrides = {}, platform: NodeJS.Platform | string = runtimeShortcutPlatform()): ShortcutBindings {
  return { ...defaultShortcutBindings(platform), ...sanitizeShortcutOverrides(overrides) };
}

export function sanitizeShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ShortcutOverrides = {};
  for (const [id, binding] of Object.entries(value)) {
    if (!definitionIds.has(id as ShortcutActionId) || typeof binding !== "string") continue;
    if (!binding || parseShortcutBinding(binding)) result[id as ShortcutActionId] = binding;
  }
  return result;
}

export function shortcutOverridesFromBindings(bindings: ShortcutBindings, platform: NodeJS.Platform | string = runtimeShortcutPlatform()): ShortcutOverrides {
  const defaults = defaultShortcutBindings(platform);
  return Object.fromEntries(SHORTCUT_DEFINITIONS.flatMap((definition) => (
    bindings[definition.id] === defaults[definition.id] ? [] : [[definition.id, bindings[definition.id]]]
  ))) as ShortcutOverrides;
}

export function shortcutBindingFromInput(input: ShortcutInput, platform: NodeJS.Platform | string): string | null {
  const key = normalizedKey(input.key);
  if (!key || modifierKeys.has(key)) return null;
  const modifiers: string[] = [];
  const modPressed = platform === "darwin" ? input.meta : input.control;
  if (modPressed) modifiers.push("Mod");
  if (platform === "darwin" ? input.control : input.meta) modifiers.push(platform === "darwin" ? "Ctrl" : "Meta");
  if (input.shift) modifiers.push("Shift");
  if (input.alt) modifiers.push("Alt");
  if (!modifiers.length && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...modifiers, key].join("+");
}

export function parseShortcutBinding(binding: string): { modifiers: string[]; key: string } | null {
  const parts = binding.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key || !parts.every((part) => ["Mod", "Ctrl", "Meta", "Shift", "Alt"].includes(part))) return null;
  if (!parts.length && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return { modifiers: parts, key };
}

export function shortcutActionForInput(
  bindings: ShortcutBindings,
  input: ShortcutInput,
  platform: NodeJS.Platform | string,
): ShortcutActionId | null {
  const binding = shortcutBindingFromInput(input, platform);
  if (!binding) return null;
  return SHORTCUT_DEFINITIONS.find((definition) => bindings[definition.id] === binding)?.id ?? null;
}

export function shortcutConflict(
  bindings: ShortcutBindings,
  action: ShortcutActionId,
  binding: string,
): ShortcutDefinition | null {
  if (!binding) return null;
  return SHORTCUT_DEFINITIONS.find((definition) => definition.id !== action && bindings[definition.id] === binding) ?? null;
}

export function shortcutValidationError(binding: string, platform: NodeJS.Platform | string = runtimeShortcutPlatform()): string {
  if (!binding) return "";
  if (!parseShortcutBinding(binding)) return "快捷键必须包含 Command/Ctrl/Option，或使用 F1–F12";
  if (reservedBindings.has(binding)) return "该组合由系统或文本编辑保留";
  if (platform === "win32" && binding === "Alt+Space") return "Alt+Space 由 Windows 窗口菜单保留";
  return "";
}

export function formatShortcutBinding(binding: string, platform: NodeJS.Platform | string): string {
  if (!binding) return "未设置";
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return binding;
  const mac = platform === "darwin";
  const modifierLabels: Record<string, string> = mac
    ? { Mod: "⌘", Ctrl: "⌃", Meta: "⌘", Shift: "⇧", Alt: "⌥" }
    : { Mod: "Ctrl", Ctrl: "Ctrl", Meta: "Meta", Shift: "Shift", Alt: "Alt" };
  return [...parsed.modifiers.map((item) => modifierLabels[item] ?? item), parsed.key].join(mac ? "" : "+");
}
