export function webSocketUrl(path: string, params: Record<string, string>, baseUrl = window.location.href): string {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}
