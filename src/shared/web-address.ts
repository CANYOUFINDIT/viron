const HOST_WITH_PORT = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d+(?:[/?#]|$)/i;
const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function defaultProtocol(value: string): "http:" | "https:" {
  try {
    const hostname = new URL(`http://${value.replace(/^\/\//, "")}`).hostname.toLowerCase();
    const localHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
    const hostLiteral = !hostname.includes(".") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
    return localHost || hostLiteral ? "http:" : "https:";
  } catch {
    return "https:";
  }
}

export function normalizeWebAddress(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const hasHttpScheme = /^https?:\/\//i.test(value);
  if (!hasHttpScheme && EXPLICIT_SCHEME.test(value) && !HOST_WITH_PORT.test(value)) return null;

  try {
    const url = new URL(hasHttpScheme ? value : `${defaultProtocol(value)}//${value.replace(/^\/\//, "")}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}
