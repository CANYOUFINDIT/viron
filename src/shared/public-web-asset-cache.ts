import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DAY = 86_400_000;
type AssetRecord = { url: string; origin: string; expiresAt: number; headers: Array<[string, string]>; bytes: number };

/** Only versioned bundles or explicitly public static files may cross account profiles. */
export function publicWebAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && /\/(?:assets|static|fonts|images|img)\/[^?#]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico)$/i.test(url.pathname)
      && [...url.searchParams].every(([key, item]) => /^(?:v|ver|version|hash)$/i.test(key) && /^[\w.-]{1,80}$/.test(item));
  } catch { return false; }
}

function expiry(url: string, headers: Headers, now: number): number {
  const policy = headers.get("cache-control") ?? "";
  if (/\b(?:private|no-store|no-cache)\b/i.test(policy) || headers.has("set-cookie")) return 0;
  if ((headers.get("vary") ?? "").split(",").some((name) => name.trim() && !/^(?:accept-encoding|origin)$/i.test(name.trim()))) return 0;
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!/^(?:(?:application|text)\/(?:javascript|x-javascript|ecmascript|css)|font\/[\w.+-]+|application\/(?:font-woff|vnd\.ms-fontobject|x-font-ttf)|image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon))$/i.test(type)) return 0;
  const versioned = /[-.][\w-]{8,}\.(?:m?js|css)$/i.test(new URL(url).pathname);
  // An anonymous 200 response alone is not permission to cache dynamic content.
  if (!versioned && !/\bpublic\b/i.test(policy)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(policy);
  const age = Number(headers.get("age") ?? 0) * 1000;
  if (maxAge) return now + Math.max(0, Math.min(Number(maxAge[1]) * 1000, 7 * DAY) - age);
  const expires = Date.parse(headers.get("expires") ?? "");
  if (Number.isFinite(expires)) return expires;
  // Follow HTTP's Last-Modified heuristic for hashed bundles without max-age.
  const modified = Date.parse(headers.get("last-modified") ?? "");
  const date = Date.parse(headers.get("date") ?? "") || now;
  return Number.isFinite(modified) ? now + Math.max(0, Math.min((date - modified) * 0.1, DAY) - age) : 0;
}

/** Public bytes only. Fetches never include an account's Cookie or Authorization. */
export class PublicWebAssetCache {
  private pending = new Map<string, Promise<{ record: AssetRecord; body: Uint8Array } | null>>();
  constructor(private directory: string, private fetchAsset: typeof fetch = globalThis.fetch, private now = Date.now) {}

  async get(url: string, origin = ""): Promise<Response | null> {
    if (!publicWebAssetUrl(url)) return null;
    const key = createHash("sha256").update(`${url}\0${origin}`).digest("hex");
    let operation = this.pending.get(key);
    if (!operation) {
      operation = this.readOrFetch(key, url, origin).catch(() => null);
      this.pending.set(key, operation);
    }
    try {
      const asset = await operation;
      return asset ? new Response(asset.body as Uint8Array<ArrayBuffer>, { status: 200, headers: asset.record.headers }) : null;
    } finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }

  private async readOrFetch(key: string, url: string, origin: string): Promise<{ record: AssetRecord; body: Uint8Array } | null> {
    const metadata = join(this.directory, `${key}.json`), contents = join(this.directory, `${key}.body`);
    try {
      const record = JSON.parse(await readFile(metadata, "utf8")) as AssetRecord;
      if (record.url === url && record.origin === origin && record.expiresAt > this.now() && record.bytes <= MAX_ASSET_BYTES) {
        const body = await readFile(contents);
        if (body.length === record.bytes) return { record, body };
      }
    } catch { /* A missing, expired or incomplete entry uses the public origin. */ }
    const response = await this.fetchAsset(url, { credentials: "omit", redirect: "error", headers: origin ? { Origin: origin } : {} });
    const expiresAt = response.status === 200 ? expiry(url, response.headers, this.now()) : 0;
    if (expiresAt <= this.now() || !response.body || Number(response.headers.get("content-length") ?? 0) > MAX_ASSET_BYTES) {
      await response.body?.cancel(); return null;
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ASSET_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, bytes), headers = new Headers(response.headers);
    // fetch has already decoded the transfer; replay decoded bytes consistently.
    for (const name of ["content-encoding", "transfer-encoding", "content-length", "connection", "keep-alive"]) headers.delete(name);
    headers.set("content-length", String(bytes));
    const record: AssetRecord = { url, origin, expiresAt, headers: [...headers], bytes };
    const temporary = `${contents}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, body, { mode: 0o600 }); await rename(temporary, contents);
      await writeFile(metadata, JSON.stringify(record), { mode: 0o600 });
    } catch { await rm(temporary, { force: true }).catch(() => undefined); }
    return { record, body };
  }
}
