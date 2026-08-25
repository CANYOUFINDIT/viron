import { translate as tr } from "../i18n.js";

export function requireDesktopString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(tr("{{0}}无效", [label]));
  return value;
}

export function requireDesktopInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 * 1024) throw new Error(tr("终端输入无效"));
  return value;
}

export function desktopBinary(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(tr("二进制数据无效"));
}
