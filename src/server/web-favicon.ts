const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function httpUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

export function faviconCandidates(html: string, pageUrl: string): string[] {
  const standard: string[] = [];
  const touch: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const values = attributes(tag);
    const rel = (values.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const href = values.get("href");
    if (!href || (!rel.includes("icon") && !rel.includes("apple-touch-icon") && !rel.includes("apple-touch-icon-precomposed"))) continue;
    const resolved = httpUrl(href, pageUrl);
    if (!resolved) continue;
    (rel.includes("icon") ? standard : touch).push(resolved);
  }
  return [...new Set([...standard, ...touch])];
}

async function limitedBytes(response: Response, maximum: number): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) return null;
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function faviconMime(bytes: Uint8Array, contentType: string | null): string | null {
  const declared = contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (/^image\/(?:png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|webp|jpeg|jpg|bmp)$/.test(declared)) return declared;
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  const prefix = Buffer.from(bytes.subarray(0, 512)).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(prefix)) return "image/svg+xml";
  return null;
}

async function fetchWithTimeout(fetcher: Fetcher, url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetcher(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: accept,
        "User-Agent": "Viron favicon loader",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function iconDataUrl(fetcher: Fetcher, url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(fetcher, url, "image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8");
    if (!response.ok) return null;
    const bytes = await limitedBytes(response, MAX_ICON_BYTES);
    if (!bytes?.length) return null;
    const mime = faviconMime(bytes, response.headers.get("content-type"));
    if (!mime) return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

export async function loadWebFavicon(entryUrl: string, fetcher: Fetcher = fetch): Promise<string | null> {
  const normalizedEntryUrl = httpUrl(entryUrl);
  if (!normalizedEntryUrl) return null;

  let pageUrl = normalizedEntryUrl;
  let candidates: string[] = [];
  try {
    const response = await fetchWithTimeout(fetcher, normalizedEntryUrl, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
    if (response.ok) {
      pageUrl = httpUrl(response.url) ?? normalizedEntryUrl;
      const bytes = await limitedBytes(response, MAX_DOCUMENT_BYTES);
      if (bytes) candidates = faviconCandidates(Buffer.from(bytes).toString("utf8"), pageUrl);
    }
  } catch {
    // Sites without a readable document may still expose the conventional root favicon.
  }

  const fallback = new URL("/favicon.ico", pageUrl).href;
  for (const candidate of [...new Set([...candidates, fallback])].slice(0, 8)) {
    const dataUrl = await iconDataUrl(fetcher, candidate);
    if (dataUrl) return dataUrl;
  }
  return null;
}
