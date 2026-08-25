export function formatBytes(value?: number): string {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function textSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sqlIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}
