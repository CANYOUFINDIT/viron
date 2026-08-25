export function normalizeSshLoginScript(script: string): string {
  const normalized = script.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}
